"""Two-way sync of the script's config files with the hub.

State per file (``files-state.json``): the hub revision last written or pushed and
the sha256 of that exact text. On each pass:

* hub revision > local revision and disk unchanged since → write hub text
* disk hash changed since we last synced                 → push local text up
* both changed                                           → push (hub records the
  conflict, keeps the local text in history, and its own revision wins on disk)

Writes are atomic (temp file + fsync + rename) and keep the file's mode, or 0600
for new files. Paths are confined to the script root; symlinks are refused.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import stat
from pathlib import Path

LOG = logging.getLogger("bambou-agent.files")


def sha(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


class FileSync:
    def __init__(self, settings, hub):
        self.root = settings.script_dir.resolve()
        self.hub = hub
        self.managed = list(settings.files)       # [(path, format)] declared locally for first enrollment
        self.state_path = settings.state_dir / "files-state.json"
        self.state: dict[str, dict] = {}
        if self.state_path.exists():
            try:
                self.state = json.loads(self.state_path.read_text())
            except ValueError:
                LOG.warning("files-state.json unreadable; re-syncing from scratch")

    # -- disk ------------------------------------------------------------------
    def _resolve(self, relative: str) -> Path:
        if relative.startswith("/") or ".." in relative.split("/"):
            raise ValueError("Path escapes the script root")
        path = (self.root / relative)
        for parent in [path, *path.parents]:
            if parent == self.root:
                break
            if parent.is_symlink():
                raise ValueError(f"Refusing to follow symlink {parent}")
        if not path.resolve().is_relative_to(self.root):
            raise ValueError("Path escapes the script root")
        return path

    def read(self, relative: str) -> str | None:
        path = self._resolve(relative)
        if not path.exists():
            return None
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        with os.fdopen(fd, "rb") as stream:
            data = stream.read(2 * 1024 * 1024)
        return data.decode("utf-8")

    def write(self, relative: str, text: str):
        path = self._resolve(relative)
        path.parent.mkdir(parents=True, exist_ok=True)
        mode = stat.S_IMODE(path.stat().st_mode) if path.exists() else 0o600
        temporary = path.with_name(f".{path.name}.hub-tmp")
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, mode)
        try:
            with os.fdopen(fd, "wb") as stream:
                stream.write(text.encode())
                stream.flush()
                os.fsync(stream.fileno())
            os.chmod(temporary, mode)
            os.replace(temporary, path)
        except BaseException:
            temporary.unlink(missing_ok=True)
            raise

    def _save(self):
        temporary = self.state_path.with_suffix(".tmp")
        temporary.write_text(json.dumps(self.state, indent=2))
        os.chmod(temporary, 0o600)
        os.replace(temporary, self.state_path)

    # -- sync ------------------------------------------------------------------
    async def sync(self) -> list[str]:
        """One pass. Returns paths rewritten from the hub (to notify the script)."""
        response = await self.hub.request("GET", "/api/agent/v2/files")
        if response.status_code != 200:
            LOG.warning("File list request failed: HTTP %s", response.status_code)
            return []
        remote = {f["path"]: f for f in response.json()["files"]}
        changed: list[str] = []
        # Enroll locally declared files the hub does not manage yet.
        for path, fmt in self.managed:
            if path not in remote:
                text = self._safe_read(path)
                if text is None:
                    continue
                result = await self._push(path, fmt, text, 0)
                if result and result.get("accepted"):
                    self.state[path] = {"revision": result["revision"], "sha256": sha(text)}
        for path, item in remote.items():
            try:
                updated = await self._sync_one(path, item)
            except (OSError, ValueError, UnicodeDecodeError) as exc:
                LOG.warning("Cannot sync %s: %s", path, exc)
                await self._ack(path, item["revision"], "", f"{type(exc).__name__}: {exc}")
                continue
            if updated:
                changed.append(path)
        for path in list(self.state):
            if path not in remote and path not in dict(self.managed):
                del self.state[path]  # hub stopped managing it; file left as-is
        self._save()
        return changed

    def _safe_read(self, path):
        try:
            return self.read(path)
        except (OSError, ValueError, UnicodeDecodeError) as exc:
            LOG.warning("Cannot read %s: %s", path, exc)
            return None

    async def _sync_one(self, path: str, item: dict) -> bool:
        local = self.read(path)
        known = self.state.get(path)
        disk_hash = sha(local) if local is not None else None
        hub_text, hub_rev, hub_hash = item["content"], item["revision"], item["sha256"]
        if disk_hash == hub_hash:
            self.state[path] = {"revision": hub_rev, "sha256": hub_hash}
            if item["applied_revision"] < hub_rev:
                await self._ack(path, hub_rev, hub_hash)
            return False
        locally_edited = local is not None and (known is None or disk_hash != known["sha256"])
        if locally_edited:
            base = known["revision"] if known else hub_rev
            result = await self._push(path, item["format"], local, base)
            if result and result.get("accepted"):
                self.state[path] = {"revision": result["revision"], "sha256": disk_hash}
                return False
            # Conflict: hub wins on disk, local text is preserved in hub history.
            LOG.warning("%s changed on both the VPS and the hub; applying hub revision %s (local copy saved in hub history)",
                        path, hub_rev)
        self.write(path, hub_text)
        self.state[path] = {"revision": hub_rev, "sha256": hub_hash}
        await self._ack(path, hub_rev, hub_hash)
        LOG.info("Applied %s revision %s from hub", path, hub_rev)
        return True

    async def _push(self, path, fmt, text, base):
        response = await self.hub.request("POST", "/api/agent/v2/files/push",
                                          {"path": path, "format": fmt, "content": text, "base_revision": base})
        if response.status_code != 200:
            LOG.warning("Hub rejected %s: %s", path, response.text[:300])
            return None
        return response.json()

    async def _ack(self, path, revision, digest, error=None):
        await self.hub.request("POST", "/api/agent/v2/files/ack",
                               {"path": path, "revision": revision, "sha256": digest, "error": error})
