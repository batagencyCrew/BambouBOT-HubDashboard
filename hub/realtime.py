"""Live connections: agents (one socket per site) and bots (alert subscribers).

The hub keeps a registry of connected agents so commands are pushed instantly.
If a site is offline, commands stay ``pending`` in Postgres and are delivered the
next time the agent connects or polls. Nothing here is required for correctness.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import time

from fastapi import WebSocket, WebSocketDisconnect

LOG = logging.getLogger("hub.realtime")


class AgentConnection:
    def __init__(self, site_id: str, websocket: WebSocket):
        self.site_id = site_id
        self.websocket = websocket
        self.queue: asyncio.Queue = asyncio.Queue(maxsize=200)
        self.connected_at = time.time()

    async def send(self, message: dict) -> bool:
        try:
            self.queue.put_nowait(message)
            return True
        except asyncio.QueueFull:
            LOG.warning("Agent %s send queue full; dropping message", self.site_id[:8])
            return False


class Realtime:
    def __init__(self, app):
        self.app = app
        self.agents: dict[str, AgentConnection] = {}
        self.bots: set[asyncio.Queue] = set()

    def startup(self):
        pass

    def shutdown(self):
        self.agents.clear()

    # -- agents ------------------------------------------------------------
    async def site_socket(self, websocket: WebSocket):
        token = websocket.query_params.get("token") or _bearer(websocket)
        site_id = self._site_from_token(token)
        if not site_id:
            await websocket.close(code=4401)
            return
        await websocket.accept()
        conn = AgentConnection(site_id, websocket)
        previous = self.agents.get(site_id)
        self.agents[site_id] = conn
        if previous:
            with contextlib.suppress(Exception):
                await previous.websocket.close(code=4000, reason="Replaced by new connection")
        await self.push_pending(site_id)
        sender = asyncio.create_task(self._drain(conn))
        try:
            while True:
                raw = await websocket.receive_text()
                await self._on_agent_message(site_id, raw)
        except WebSocketDisconnect:
            pass
        finally:
            sender.cancel()
            if self.agents.get(site_id) is conn:
                del self.agents[site_id]

    async def _drain(self, conn: AgentConnection):
        while True:
            message = await conn.queue.get()
            await conn.websocket.send_text(json.dumps(message, default=str))

    async def _on_agent_message(self, site_id: str, raw: str):
        if len(raw) > 8 * 1024 * 1024:
            return
        try:
            message = json.loads(raw)
        except ValueError:
            return
        if not isinstance(message, dict):
            return
        kind = message.get("type")
        if kind == "ping":
            from .ingest import presence_reply
            reply = await asyncio.to_thread(presence_reply, self.app, site_id)
            await self.agents[site_id].send({**reply, "type": "pong", "ts": time.time()})
        elif kind == "ack":
            from .ingest import handle_ack
            await asyncio.to_thread(handle_ack, self.app, site_id, message)
        elif kind == "result":
            from .ingest import handle_command_result
            await asyncio.to_thread(handle_command_result, self.app, site_id, message)
        elif kind == "presence":
            from .ingest import handle_presence
            await asyncio.to_thread(handle_presence, self.app, site_id, message)
        elif kind == "batch":
            from .routers.agent import Batch, apply_batch
            try:
                batch = Batch.model_validate({k: v for k, v in message.items() if k != "type"})
            except ValueError:
                return
            reply = await asyncio.to_thread(apply_batch, self.app, site_id, batch)
            await self.agents[site_id].send({**reply, "type": "batch_ok", "seq": message.get("seq")})

    def is_online(self, site_id: str) -> bool:
        return site_id in self.agents

    def online_sites(self) -> list[str]:
        return list(self.agents)

    def send_command(self, site_id: str, command: dict) -> bool:
        conn = self.agents.get(site_id)
        if not conn:
            return False
        try:
            conn.queue.put_nowait({"type": "command", **command})
            return True
        except asyncio.QueueFull:
            return False

    def send_site(self, site_id: str, message: dict) -> bool:
        conn = self.agents.get(site_id)
        if not conn:
            return False
        try:
            conn.queue.put_nowait(message)
            return True
        except asyncio.QueueFull:
            return False

    async def push_pending(self, site_id: str):
        """Deliver commands left pending while the agent was disconnected."""
        from .ingest import open_commands
        rows = await asyncio.to_thread(open_commands, self.app, site_id)
        for row in rows:
            self.send_command(site_id, row)

    # -- bots --------------------------------------------------------------
    async def bot_socket(self, websocket: WebSocket):
        token = websocket.query_params.get("token") or _bearer(websocket)
        if not self._bot_token_valid(token):
            await websocket.close(code=4401)
            return
        await websocket.accept()
        queue: asyncio.Queue = asyncio.Queue(maxsize=self.app.state.settings.bot_stream_queue)
        self.bots.add(queue)
        sender = asyncio.create_task(self._drain_bot(queue, websocket))
        try:
            while True:
                await websocket.receive_text()
        except WebSocketDisconnect:
            pass
        finally:
            sender.cancel()
            self.bots.discard(queue)

    async def _drain_bot(self, queue: asyncio.Queue, websocket: WebSocket):
        while True:
            await websocket.send_text(json.dumps(await queue.get(), default=str))

    def publish(self, event: dict):
        for queue in list(self.bots):
            try:
                queue.put_nowait(event)
            except asyncio.QueueFull:
                pass

    # -- helpers -----------------------------------------------------------
    def _site_from_token(self, token: str | None) -> str | None:
        if not token or len(token) > 200:
            return None
        from .auth import sha256
        row = self.app.state.db.one(
            "SELECT site_id FROM site_tokens WHERE token_hash=%s AND revoked_at IS NULL", (sha256(token),))
        return str(row["site_id"]) if row else None

    def _bot_token_valid(self, token: str | None) -> bool:
        from .auth import sha256
        if not token:
            return False
        return self.app.state.db.one(
            "SELECT 1 AS ok FROM service_tokens WHERE token_hash=%s AND revoked_at IS NULL AND kind='bot'",
            (sha256(token),)) is not None


def _bearer(websocket: WebSocket) -> str | None:
    header = websocket.headers.get("authorization", "")
    if header.lower().startswith("bearer "):
        return header[7:].strip()
    return None
