"""bambou-agent: one per VPS. See agent2/README.md for setup."""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import platform
import shlex
import signal
import socket
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path

import psutil

from . import __version__
from .backup import BackupRunner
from .files import FileSync
from .hubclient import HubClient
from .local import LocalServer
from .supervisor import Supervisor, parse_command

LOG = logging.getLogger("bambou-agent")
PRESENCE_INTERVAL = 10
FILE_SYNC_INTERVAL = 30


@dataclass
class Settings:
    hub_url: str
    hub_token: str = field(repr=False)
    script_dir: Path
    state_dir: Path
    socket_path: Path
    command: list[str]
    files: list[tuple[str, str | None]]
    crash_restart: bool = True
    stop_timeout: int = 20
    backup_enabled: bool = True
    backup_exclude: list[str] = field(default_factory=list)
    extra_env: dict = field(default_factory=dict)
    site_id: str | None = None
    version: str = __version__
    autostart: bool = False

    @property
    def command_display(self) -> str:
        return shlex.join(self.command) if self.command else ""


class Agent:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.hub = HubClient(settings, self.on_hub_message)
        self.local = LocalServer(settings, self.on_sdk_batch)
        self.process = Supervisor(settings, self.report)
        self.files = FileSync(settings, self.hub)
        self.backups = BackupRunner(settings, self.hub, self.report)
        self.desired_state = "stopped"
        self.config_revision = None
        self.pending_logs: list[dict] = []
        self.handled: dict[str, float] = {}
        self._wake_files = asyncio.Event()
        psutil.cpu_percent(None)

    # -- reporting ---------------------------------------------------------------
    def report(self, level: str, message: str):
        LOG.log(logging.ERROR if level in ("error", "critical") else logging.WARNING if level == "warning" else logging.INFO,
                message.splitlines()[0])
        self.hub.submit({"logs": [{"level": level, "message": message[:8000], "source": "bambou-agent",
                                   "ts": _now()}]})

    def presence(self) -> dict:
        workers = self.local.merged_workers()
        if not self.process.running:
            workers = [{**w, "status": "stopped"} for w in workers]
        disk = psutil.disk_usage(str(self.settings.script_dir))
        memory = psutil.virtual_memory()
        host = {"hostname": socket.gethostname(), "os": f"{platform.system()} {platform.release()}",
                "cpu_percent": psutil.cpu_percent(None), "cpu_count": psutil.cpu_count(),
                "load": list(os.getloadavg()), "memory_percent": memory.percent,
                "memory_total_mb": memory.total // 1024**2, "disk_percent": disk.percent,
                "disk_free_gb": round(disk.free / 1024**3, 1), "uptime": int(time.time() - psutil.boot_time()),
                "sdk_clients": self.local.connected, "spooled_batches": len(self.hub.spool.pending()),
                "hub_link": "websocket" if self.hub.connected.is_set() else "http"}
        return {"agent_version": __version__, "workers": workers, "host": host, "process": self.process.snapshot(),
                "backup": self.backups.snapshot(), "capabilities": self.local.merged_capabilities()}

    async def presence_loop(self):
        while True:
            self.hub.submit({"presence": self.presence()})
            await asyncio.sleep(PRESENCE_INTERVAL)

    # -- SDK → hub -----------------------------------------------------------------
    async def on_sdk_batch(self, message: dict, client_id: int):
        batch = {k: message[k] for k in ("logs", "metrics", "costs", "balances", "proxies", "issues", "acks")
                 if message.get(k)}
        if batch:
            self.hub.submit(batch)

    # -- hub → agent ---------------------------------------------------------------
    async def on_hub_message(self, message: dict):
        kind = message.get("type")
        if kind == "command":
            await self.handle_command(message)
        elif kind == "files_changed":
            self._wake_files.set()
        elif kind == "backup_config_changed":
            await self.backups.refresh_config()
        elif kind in ("pong", "presence_ok", "batch_ok"):
            await self.apply_desired(message.get("desired_state"))

    async def apply_desired(self, state: str | None):
        if state not in ("running", "paused", "stopped") or state == self.desired_state:
            return
        previous, self.desired_state = self.desired_state, state
        self.process.desired = state
        if state == "running" and not self.process.running and self.settings.autostart and not self.process.crash_loop:
            await self.process.start("desired state")
        await self.local.broadcast({"type": "state", "paused": state == "paused"})
        LOG.info("Desired state %s → %s", previous, state)

    async def handle_command(self, message: dict):
        command_id = message.get("command_id", "")
        if command_id in self.handled:
            return  # at-least-once delivery: ignore repeats
        self.handled[command_id] = time.time()
        if len(self.handled) > 2000:
            for key in sorted(self.handled, key=self.handled.get)[:1000]:
                self.handled.pop(key, None)
        action = message.get("action", "")
        args = message.get("args") or {}
        LOG.info("Command %s %s", action, args or "")
        try:
            if action == "start":
                self.desired_state = self.process.desired = "running"
                self.process.crash_loop = False
                result = await self.process.start()
                await self.local.broadcast({"type": "state", "paused": False})
                await self.hub.ack(command_id, "completed", result)
            elif action == "stop":
                self.desired_state = self.process.desired = "stopped"
                await self.local.broadcast({"type": "command", "command_id": "", "action": "stop", "args": {}})
                result = await self.process.stop()
                await self.hub.ack(command_id, "completed", result)
            elif action == "restart":
                self.desired_state = self.process.desired = "running"
                self.process.crash_loop = False
                result = await self.process.restart()
                await self.hub.ack(command_id, "completed", result)
            elif action == "backup":
                await self.hub.ack(command_id, "running", "Backup started")
                ok, result = await self.backups.run("manual", command_id)
                if not ok:
                    await self.hub.ack(command_id, "failed", result)
            elif action == "reload_config":
                changed = await self.files.sync()
                await self.local.broadcast({"type": "files_changed", "paths": changed})
                forwarded = await self.local.broadcast({**message, "type": "command"})
                if not forwarded:
                    await self.hub.ack(command_id, "completed", f"Files synced ({len(changed)} updated); script not connected")
            elif action in ("pause", "resume"):
                self.desired_state = self.process.desired = "paused" if action == "pause" else "running"
                forwarded = await self.local.broadcast({**message, "type": "command"})
                if not forwarded:
                    await self.hub.ack(command_id, "failed", "Script is not connected through the SDK; cannot pause it")
            else:  # set_workers and custom:* are the script's to handle
                forwarded = await self.local.broadcast({**message, "type": "command"})
                if not forwarded:
                    await self.hub.ack(command_id, "failed", "Script is not connected through the SDK")
        except Exception as exc:
            LOG.exception("Command %s failed", action)
            await self.hub.ack(command_id, "failed", f"{type(exc).__name__}: {exc}"[:2000])

    # -- files -----------------------------------------------------------------------
    async def files_loop(self):
        first = True
        while True:
            if not first:
                try:
                    await asyncio.wait_for(self._wake_files.wait(), timeout=FILE_SYNC_INTERVAL)
                except asyncio.TimeoutError:
                    pass
            first = False
            self._wake_files.clear()
            try:
                changed = await self.files.sync()
            except Exception as exc:
                LOG.warning("File sync failed: %s", exc)
                continue
            if changed:
                await self.local.broadcast({"type": "files_changed", "paths": changed})

    # -- lifecycle -------------------------------------------------------------------
    async def run(self):
        self.settings.state_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        await self.local.start()
        whoami = await self._whoami()
        if whoami:
            self.settings.site_id = whoami["site_id"]
            self.desired_state = self.process.desired = whoami["desired_state"]
            LOG.info("Agent for site %s (%s); desired state %s", whoami["name"], whoami["slug"], self.desired_state)
        await self.backups.refresh_config()
        if self.desired_state in ("running", "paused") and self.settings.command:
            await self.process.start("agent start")
        tasks = [asyncio.create_task(t) for t in (self.hub.start(), self.presence_loop(), self.files_loop(),
                                                  self.backups.loop(), self._backup_config_loop())]
        stop = asyncio.Event()
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGTERM, signal.SIGINT):
            loop.add_signal_handler(sig, stop.set)
        await stop.wait()
        LOG.info("Shutting down")
        if self.process.running:
            await self.process.stop("agent shutdown")
        self.hub.submit({"presence": self.presence()})
        await asyncio.sleep(0.5)
        for task in tasks:
            task.cancel()
        await self.local.stop()
        await self.hub.stop()

    async def _whoami(self):
        self.hub.open_http()
        for attempt in range(1, 1000):
            try:
                response = await self.hub.request("GET", "/api/agent/v2/whoami")
                if response.status_code == 200:
                    return response.json()
                if response.status_code == 401:
                    LOG.error("Hub rejected the agent token (401). Check HUB_AGENT_TOKEN.")
                    sys.exit(2)
            except Exception as exc:
                LOG.warning("Hub unreachable (%s); retrying", type(exc).__name__)
            await asyncio.sleep(min(60, 2 * attempt))

    async def _backup_config_loop(self):
        while True:
            await asyncio.sleep(600)
            await self.backups.refresh_config()


def _now():
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat()


def load_settings(argv=None) -> Settings:
    parser = argparse.ArgumentParser(prog="bambou-agent", description="Connects one automation script to the Bambou hub.")
    parser.add_argument("--hub-url", default=os.environ.get("HUB_URL"))
    parser.add_argument("--script-dir", default=os.environ.get("HUB_SCRIPT_DIR", "."),
                        help="Script root; config files and backups are relative to it")
    parser.add_argument("--state-dir", default=os.environ.get("HUB_STATE_DIR"))
    parser.add_argument("--command", default=os.environ.get("HUB_SCRIPT_COMMAND"),
                        help="How to start the script, e.g. 'python3 bot.py'. Omit to only relay telemetry.")
    parser.add_argument("--file", action="append", default=[],
                        help="Config file to manage, relative to the script dir; optional ':format' suffix "
                             "(json, env, proxies, proxy-json, text). Repeatable.")
    parser.add_argument("--no-crash-restart", action="store_true")
    parser.add_argument("--autostart", action="store_true", help="Start the script when the hub says it should run")
    parser.add_argument("--stop-timeout", type=int, default=int(os.environ.get("HUB_STOP_TIMEOUT", "20")))
    parser.add_argument("--no-backup", action="store_true")
    parser.add_argument("--backup-exclude", action="append", default=[])
    parser.add_argument("--env", action="append", default=[], help="Extra KEY=VALUE for the script environment")
    parser.add_argument("--log-level", default=os.environ.get("HUB_AGENT_LOG_LEVEL", "INFO"))
    args = parser.parse_args(argv)
    logging.basicConfig(level=args.log_level.upper(), format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    token = os.environ.get("HUB_AGENT_TOKEN", "")
    if not args.hub_url or not token:
        parser.error("HUB_URL and HUB_AGENT_TOKEN must be set (environment or --hub-url)")
    if not args.hub_url.startswith("https://") and not args.hub_url.startswith(("http://127.", "http://localhost")):
        parser.error("HUB_URL must use https:// (plain http only for localhost)")
    script_dir = Path(args.script_dir).resolve()
    state_dir = Path(args.state_dir).resolve() if args.state_dir else script_dir / ".bambou-agent"
    files = []
    for spec in args.file or [p for p in os.environ.get("HUB_FILES", "").split(",") if p]:
        path, _, fmt = spec.partition(":")
        files.append((path.strip(), fmt.strip() or None))
    env = dict(item.split("=", 1) for item in args.env if "=" in item)
    excludes = list(args.backup_exclude)
    try:
        excludes.append(state_dir.relative_to(script_dir).as_posix())
    except ValueError:
        pass
    return Settings(hub_url=args.hub_url, hub_token=token, script_dir=script_dir, state_dir=state_dir,
                    socket_path=Path(os.environ.get("HUB_AGENT_SOCKET", state_dir / "agent.sock")),
                    command=parse_command(args.command), files=files, crash_restart=not args.no_crash_restart,
                    stop_timeout=args.stop_timeout, backup_enabled=not args.no_backup, backup_exclude=excludes,
                    extra_env=env, autostart=args.autostart or bool(args.command))


def main(argv=None):
    settings = load_settings(argv)
    try:
        asyncio.run(Agent(settings).run())
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
