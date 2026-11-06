"""Unix socket the script's SDK connects to (newline-delimited JSON).

Several SDK clients may connect (multi-process scripts: one per process). The
agent merges their worker lists into one presence report, forwards their batches
to the hub, and broadcasts commands/file-change notices to all of them.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os

LOG = logging.getLogger("bambou-agent.local")
MAX_LINE = 16 * 1024 * 1024


class LocalServer:
    def __init__(self, settings, on_batch):
        self.path = settings.socket_path
        self.on_batch = on_batch               # callable(batch, client_id)
        self.clients: dict[int, asyncio.StreamWriter] = {}
        self.workers: dict[int, list[dict]] = {}
        self.capabilities: dict[int, dict] = {}
        self.server: asyncio.base_events.Server | None = None
        self._next = 0

    async def start(self):
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        if self.path.exists() or self.path.is_symlink():
            self.path.unlink()  # stale socket from a previous run
        old_umask = os.umask(0o077)
        try:
            self.server = await asyncio.start_unix_server(self._client, path=str(self.path), limit=MAX_LINE)
        finally:
            os.umask(old_umask)
        os.chmod(self.path, 0o600)

    async def stop(self):
        if self.server:
            self.server.close()
        for writer in list(self.clients.values()):
            writer.close()
        try:
            self.path.unlink()
        except FileNotFoundError:
            pass

    @property
    def connected(self) -> int:
        return len(self.clients)

    def merged_workers(self) -> list[dict]:
        merged: dict[str, dict] = {}
        for items in self.workers.values():
            for worker in items:
                merged[worker["id"]] = worker
        return list(merged.values())

    def merged_capabilities(self) -> dict:
        commands: dict[str, dict] = {}
        sdk = ""
        for caps in self.capabilities.values():
            sdk = caps.get("sdk", sdk)
            for command in caps.get("commands", []):
                commands[command["name"]] = command
        return {"sdk": sdk, "commands": list(commands.values())}

    async def broadcast(self, message: dict) -> int:
        data = (json.dumps(message, default=str) + "\n").encode()
        sent = 0
        for client_id, writer in list(self.clients.items()):
            try:
                writer.write(data)
                await writer.drain()
                sent += 1
            except (ConnectionError, OSError):
                self._drop(client_id)
        return sent

    def _drop(self, client_id: int):
        writer = self.clients.pop(client_id, None)
        self.workers.pop(client_id, None)
        self.capabilities.pop(client_id, None)
        if writer:
            writer.close()

    async def _client(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
        self._next += 1
        client_id = self._next
        self.clients[client_id] = writer
        try:
            while True:
                try:
                    line = await reader.readline()
                except (asyncio.LimitOverrunError, ValueError):
                    LOG.warning("SDK client sent an oversized message; disconnecting it")
                    break
                if not line:
                    break
                try:
                    message = json.loads(line)
                except ValueError:
                    continue
                if not isinstance(message, dict):
                    continue
                if message.get("type") == "batch":
                    presence = message.get("presence") or {}
                    if isinstance(presence.get("workers"), list):
                        self.workers[client_id] = presence["workers"][:500]
                    if isinstance(presence.get("capabilities"), dict):
                        self.capabilities[client_id] = presence["capabilities"]
                    await self.on_batch(message, client_id)
        except (ConnectionError, OSError):
            pass
        finally:
            # Workers of a vanished process are reported stopped by the next presence.
            self._drop(client_id)
