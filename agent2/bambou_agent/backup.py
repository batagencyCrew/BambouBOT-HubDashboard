"""Codebase backups: tar.gz of the script directory streamed to the hub.

Excludes come from the hub's per-site config (defaults: .git, node_modules,
__pycache__, .venv, venv) plus the agent's own state dir. Symlinks are stored as
links (never followed), sockets/devices skipped. The archive is built in the
state dir, then uploaded; it is deleted afterwards either way.

Outcome handling (fixes the v1 bugs):
* 2xx          → done, schedule next
* 4xx (not 408/429) → permanent: report failure, do NOT retry this request
* 408/429/5xx/network → transient: retry with backoff (2, 5, 15, 30, 60 min)
"""

from __future__ import annotations

import asyncio
import fnmatch
import logging
import os
import tarfile
import time
from datetime import datetime, timezone
from pathlib import Path

import httpx

LOG = logging.getLogger("bambou-agent.backup")
RETRY_MINUTES = [2, 5, 15, 30, 60]


class BackupRunner:
    def __init__(self, settings, hub, report):
        self.settings = settings
        self.hub = hub
        self.report = report
        self.config = {"enabled": False, "interval_minutes": 1440, "exclude": [], "last_backup_at": None,
                       "max_bytes": 4 * 1024**3}
        self.running = False
        self.last_result: dict = {}
        self.next_at: float | None = None
        self.failures = 0

    def snapshot(self) -> dict:
        return {"configured": self.settings.backup_enabled, "running": self.running, "next_at": self.next_at,
                **({"last": self.last_result} if self.last_result else {})}

    async def refresh_config(self):
        try:
            response = await self.hub.request("GET", "/api/agent/v2/backups/config")
            if response.status_code == 200:
                self.config = response.json()
        except httpx.HTTPError:
            pass
        self._schedule()

    def _schedule(self):
        if not self.config.get("enabled") or not self.settings.backup_enabled:
            self.next_at = None
            return
        last = self.config.get("last_backup_at")
        last_ts = datetime.fromisoformat(last.replace("Z", "+00:00")).timestamp() if last else 0
        interval = self.config.get("interval_minutes", 1440) * 60
        if self.failures:
            retry = RETRY_MINUTES[min(self.failures - 1, len(RETRY_MINUTES) - 1)] * 60
            base = self.last_result.get("at", time.time())
            self.next_at = base + retry
        else:
            self.next_at = max(last_ts + interval, time.time() + 30) if last_ts else time.time() + 60

    async def loop(self):
        while True:
            await asyncio.sleep(30)
            if self.next_at and time.time() >= self.next_at and not self.running:
                await self.run("scheduled")

    async def run(self, source: str, command_id: str | None = None) -> tuple[bool, str]:
        if not self.settings.backup_enabled:
            return False, "Backups disabled on this VPS (--no-backup)"
        if self.running:
            return False, "A backup is already running"
        self.running = True
        archive = self.settings.state_dir / f"backup-{int(time.time())}.tar.gz"
        try:
            size = await asyncio.to_thread(self._pack, archive)
            if size > self.config.get("max_bytes", 4 * 1024**3):
                return self._finish(False, f"Archive is {size // 1024**2} MiB, over the hub limit; add excludes", permanent=True)
            ok, message, permanent = await self._upload(archive, source, command_id, size)
            return self._finish(ok, message, permanent)
        except Exception as exc:
            LOG.exception("Backup failed")
            return self._finish(False, f"Backup failed: {type(exc).__name__}: {exc}", permanent=False)
        finally:
            archive.unlink(missing_ok=True)
            self.running = False

    def _finish(self, ok: bool, message: str, permanent: bool = False) -> tuple[bool, str]:
        self.last_result = {"ok": ok, "message": message, "at": time.time()}
        if ok:
            self.failures = 0
            self.config["last_backup_at"] = datetime.now(timezone.utc).isoformat()
            LOG.info("Backup uploaded: %s", message)
        else:
            self.failures = 0 if permanent else self.failures + 1
            self.report("error" if permanent or self.failures >= 3 else "warning", f"Backup failed: {message}")
        self._schedule()
        return ok, message

    def _excluded(self, relative: str, name: str) -> bool:
        patterns = list(self.config.get("exclude") or []) + list(self.settings.backup_exclude)
        return any(fnmatch.fnmatch(name, p) or fnmatch.fnmatch(relative, p) or relative.startswith(p.rstrip("/") + "/")
                   for p in patterns)

    def _pack(self, archive: Path) -> int:
        root = self.settings.script_dir.resolve()
        state = self.settings.state_dir.resolve()
        fd = os.open(archive, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "wb") as raw, tarfile.open(fileobj=raw, mode="w:gz", compresslevel=6) as tar:
            for directory, dirs, files in os.walk(root, followlinks=False):
                current = Path(directory)
                rel_dir = current.relative_to(root).as_posix()
                rel_dir = "" if rel_dir == "." else rel_dir
                keep = []
                for d in dirs:
                    rel = f"{rel_dir}/{d}" if rel_dir else d
                    full = current / d
                    if full.resolve() == state or self._excluded(rel, d):
                        continue
                    if full.is_symlink():
                        tar.add(full, arcname=rel, recursive=False)
                        continue
                    keep.append(d)
                dirs[:] = keep
                for name in files:
                    rel = f"{rel_dir}/{name}" if rel_dir else name
                    full = current / name
                    if self._excluded(rel, name):
                        continue
                    try:
                        mode = full.lstat().st_mode
                    except OSError:
                        continue
                    import stat as st
                    if not (st.S_ISREG(mode) or st.S_ISLNK(mode)):
                        continue
                    try:
                        tar.add(full, arcname=rel, recursive=False)
                    except (OSError, PermissionError) as exc:
                        LOG.warning("Skipping %s: %s", rel, exc)
        return archive.stat().st_size

    async def _upload(self, archive: Path, source: str, command_id: str | None, size: int):
        params = {"source": source, "size": str(size)}
        if command_id:
            params["command_id"] = command_id

        async def body():
            with open(archive, "rb") as stream:
                while chunk := stream.read(1024 * 1024):
                    yield chunk
        try:
            response = await self.hub.request_stream("POST", "/api/agent/v2/backups/upload", params, body(),
                                                     timeout=max(3600, size // (256 * 1024)))
        except httpx.HTTPError as exc:
            return False, f"Network error: {type(exc).__name__}", False
        if response.status_code in (200, 201):
            data = response.json()
            return True, f"{data['filename']} ({data['size_bytes'] // 1024} KiB)", False
        try:
            detail = response.json().get("detail", "")
        except ValueError:
            detail = response.text[:200]
        permanent = 400 <= response.status_code < 500 and response.status_code not in (408, 429)
        return False, f"HTTP {response.status_code}: {detail}", permanent
