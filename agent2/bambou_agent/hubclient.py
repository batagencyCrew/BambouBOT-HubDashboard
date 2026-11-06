"""Agent ⇄ hub link.

Primary: WebSocket (``/ws/site``) for instant commands and streaming batches.
Fallback: HTTPS POSTs to ``/api/agent/v2/*`` with command polling.
Either way, anything that cannot be sent is spooled to disk and replayed in
order, so a hub outage or reboot loses nothing.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from pathlib import Path

import httpx
from websockets.asyncio.client import connect as ws_connect

LOG = logging.getLogger("bambou-agent.hub")
SPOOL_LIMIT = 200 * 1024 * 1024     # bytes per site before oldest batches are dropped


class Spool:
    """Append-only JSONL spool of unsent batches, one file per batch (small ones batched)."""

    def __init__(self, directory: Path):
        self.dir = directory / "spool"
        self.dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.bytes = sum(f.stat().st_size for f in self.dir.glob("*.json"))
        self.dropped = 0

    def add(self, batch: dict):
        if self.bytes >= SPOOL_LIMIT:
            oldest = sorted(self.dir.glob("*.json"))
            if oldest:
                self.bytes -= oldest[0].stat().st_size
                oldest[0].unlink(missing_ok=True)
                self.dropped += 1
        name = f"{time.time_ns():020d}.json"
        path = self.dir / name
        data = json.dumps(batch, default=str)
        path.write_text(data)
        os.chmod(path, 0o600)
        self.bytes += len(data)

    def pending(self) -> list[Path]:
        return sorted(self.dir.glob("*.json"))[:50]

    def ack(self, path: Path):
        try:
            self.bytes -= path.stat().st_size
        except FileNotFoundError:
            return
        path.unlink(missing_ok=True)


class HubClient:
    def __init__(self, settings, on_message):
        self.settings = settings
        self.on_message = on_message          # async callback(message dict)
        self.spool = Spool(settings.state_dir)
        self.queue: asyncio.Queue = asyncio.Queue(maxsize=1000)
        self.ws = None
        self.connected = asyncio.Event()
        self._stopping = False
        self._http: httpx.AsyncClient | None = None

    @property
    def base(self) -> str:
        return self.settings.hub_url.rstrip("/")

    def _headers(self) -> dict:
        return {"Authorization": f"Bearer {self.settings.hub_token}", "User-Agent": f"bambou-agent/{self.settings.version}"}

    def open_http(self):
        if self._http is None:
            self._http = httpx.AsyncClient(timeout=30, headers=self._headers(), verify=True, follow_redirects=False)

    async def start(self):
        self.open_http()
        await asyncio.gather(self._socket_loop(), self._sender_loop(), self._poller_loop())

    async def stop(self):
        self._stopping = True
        if self.ws:
            await self.ws.close()
        if self._http:
            await self._http.aclose()

    # queueing --------------------------------------------------------------
    def submit(self, batch: dict):
        try:
            self.queue.put_nowait(batch)
        except asyncio.QueueFull:
            self.spool.add(batch)

    # websocket -------------------------------------------------------------
    async def _socket_loop(self):
        url = self.base.replace("https://", "wss://").replace("http://", "ws://") + "/ws/site"
        backoff = 1
        while not self._stopping:
            try:
                async with ws_connect(url, ping_interval=20, ping_timeout=20, max_size=8 * 1024 * 1024,
                                      open_timeout=20, additional_headers=self._headers()) as ws:
                    self.ws = ws
                    self.connected.set()
                    backoff = 1
                    LOG.info("Connected to hub")
                    await self._flush_spool()
                    reader = asyncio.create_task(self._read(ws))
                    await reader
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                LOG.debug("WebSocket link down: %s", exc)
            finally:
                self.ws = None
                self.connected.clear()
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 60)

    async def _read(self, ws):
        async for raw in ws:
            try:
                message = json.loads(raw)
            except ValueError:
                continue
            if isinstance(message, dict):
                await self.on_message(message)

    # sending ---------------------------------------------------------------
    async def _sender_loop(self):
        while not self._stopping:
            batch = await self.queue.get()
            if not await self._send(batch):
                self.spool.add(batch)

    async def _flush_spool(self):
        for path in self.spool.pending():
            try:
                batch = json.loads(path.read_text())
            except ValueError:
                self.spool.ack(path)
                continue
            if not await self._send(batch):
                return
            self.spool.ack(path)

    async def _send(self, batch: dict) -> bool:
        if self.ws is not None:
            try:
                await self.ws.send(json.dumps({"type": "batch", **batch}, default=str))
                return True
            except Exception:
                self.ws = None
                self.connected.clear()
        if self._http is None:
            return False
        try:
            response = await self._http.post(f"{self.base}/api/agent/v2/batch", json=batch, timeout=60)
            return response.status_code == 200
        except httpx.HTTPError:
            return False

    # http fallback ---------------------------------------------------------
    async def _poller_loop(self):
        """When the socket is down, poll commands and retry the spool over HTTPS."""
        while not self._stopping:
            await asyncio.sleep(5)
            if self.connected.is_set() or self._http is None:
                continue
            try:
                response = await self._http.get(f"{self.base}/api/agent/v2/commands", timeout=30)
                if response.status_code == 200:
                    for command in response.json() or []:
                        await self.on_message({"type": "command", **command})
            except httpx.HTTPError:
                continue

    async def request(self, method: str, path: str, json_body=None, timeout: float = 60):
        if self._http is None:
            raise RuntimeError("Hub client not started")
        return await self._http.request(method, f"{self.base}{path}", json=json_body, timeout=timeout)

    async def request_stream(self, method: str, path: str, params: dict, body, timeout: float = 3600):
        if self._http is None:
            raise RuntimeError("Hub client not started")
        return await self._http.request(method, f"{self.base}{path}", params=params, content=body,
                                        headers={"Content-Type": "application/octet-stream"},
                                        timeout=httpx.Timeout(timeout, connect=30, read=120, write=120))

    async def ack(self, command_id: str, status: str, message: str = ""):
        if not command_id:
            return
        self.submit({"acks": [{"command_id": command_id, "status": status, "message": message}]})
