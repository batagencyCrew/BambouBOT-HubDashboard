"""Codebase backups: agent upload → hub staging → rclone copy to each destination.

Layout on a destination:  <remote>:<folder>/<site-slug>/<site-slug>-<UTC timestamp>.tar.gz

Retention: after a successful copy the hub lists that site folder and deletes
the oldest archives beyond ``keep_count``. Local staging copies are deleted once
every destination succeeded (or after LOCAL_KEEP_HOURS for partial/failed ones),
so the hub disk never fills with old archives.

Errors are classified so the agent knows whether retrying makes sense:
  * 4xx  → permanent (bad request, disabled, too large): agent must not retry
  * 503  → hub temporarily cannot accept (staging full); retry later
"""

from __future__ import annotations

import hashlib
import logging
import os
import re
import shutil
import subprocess
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path

LOG = logging.getLogger("hub.backups")
LOCAL_KEEP_HOURS = 72
MAX_ATTEMPTS = 6
BACKOFF = [30, 120, 600, 1800, 3600, 7200]  # seconds; ~3.5 h total before giving up
REMOTE_NAME = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_. -]{0,63}$")
FOLDER = re.compile(r"^[A-Za-z0-9_. -]+(?:/[A-Za-z0-9_. -]+)*$")


def now():
    return datetime.now(timezone.utc)


class Rclone:
    def __init__(self, binary: str, config: str | None):
        self.binary = binary
        self.config = config

    def _cmd(self, *args) -> list[str]:
        cmd = [self.binary]
        if self.config:
            cmd += ["--config", self.config]
        return cmd + list(args)

    def run(self, *args, timeout: int = 3600) -> subprocess.CompletedProcess:
        return subprocess.run(self._cmd(*args), capture_output=True, text=True, timeout=timeout,
                              env={"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": os.environ.get("HOME", "/tmp")})

    def remotes(self) -> list[str]:
        try:
            result = self.run("listremotes", timeout=15)
        except (OSError, subprocess.TimeoutExpired):
            return []
        if result.returncode:
            return []
        return [r.rstrip(":") for r in result.stdout.split() if REMOTE_NAME.match(r.rstrip(":"))]

    def copy(self, source: Path, target: str) -> tuple[bool, str]:
        try:
            result = self.run("copyto", "--retries", "3", "--low-level-retries", "10", "--checksum", str(source), target)
        except subprocess.TimeoutExpired:
            return False, "rclone timed out"
        except OSError as exc:
            return False, f"rclone unavailable: {exc.strerror}"
        if result.returncode:
            return False, _clean(result.stderr)
        return True, ""

    def list_files(self, folder: str) -> list[str]:
        try:
            result = self.run("lsf", "--files-only", folder, timeout=120)
        except (OSError, subprocess.TimeoutExpired):
            return []
        return [line.strip() for line in result.stdout.splitlines() if line.strip()] if result.returncode == 0 else []

    def delete(self, target: str) -> bool:
        try:
            return self.run("deletefile", target, timeout=300).returncode == 0
        except (OSError, subprocess.TimeoutExpired):
            return False


def _clean(stderr: str) -> str:
    lines = [l for l in stderr.strip().splitlines() if l.strip()]
    text = lines[-1] if lines else "rclone failed"
    return re.sub(r"(?i)(token|secret|key|password)[^\s]*", "[redacted]", text)[:500]


class BackupService:
    def __init__(self, app):
        self.app = app
        self.db = app.state.db
        settings = app.state.settings
        self.root = settings.data_dir / "backups"
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.rclone = Rclone(settings.rclone_binary, settings.rclone_config)
        self.max_upload = settings.max_backup_upload_bytes
        self.lock = threading.Lock()

    # -- upload ----------------------------------------------------------------
    def staging_free(self) -> int:
        usage = shutil.disk_usage(self.root)
        return usage.free

    def begin(self, site: dict, source: str, size_hint: int | None, requested_by=None, note: str = "") -> dict:
        if size_hint is not None and size_hint > self.max_upload:
            raise BackupRejected(413, f"Archive larger than the {self.max_upload} byte limit")
        if self.staging_free() < max(size_hint or 0, 0) + 512 * 1024**2:
            raise BackupRejected(503, "Hub staging disk is full; retry later")
        stamp = now().strftime("%Y%m%dT%H%M%SZ")
        filename = f"{site['slug']}-{stamp}.tar.gz"
        row = self.db.one("INSERT INTO backups(site_id, source, filename, requested_by, note) VALUES(%s,%s,%s,%s,%s) RETURNING *",
                          (site["id"], source, filename, requested_by, note[:500]))
        return row

    def receive(self, backup: dict, chunks) -> dict:
        """Stream the archive to disk, hashing as it goes. ``chunks`` is a sync iterator."""
        path = self.root / f"{backup['id']}.tar.gz"
        partial = path.with_suffix(".part")
        digest = hashlib.sha256()
        size = 0
        try:
            with open(partial, "wb") as stream:
                os.fchmod(stream.fileno(), 0o600)
                for chunk in chunks:
                    size += len(chunk)
                    if size > self.max_upload:
                        raise BackupRejected(413, "Archive exceeded the upload limit")
                    digest.update(chunk)
                    stream.write(chunk)
                stream.flush()
                os.fsync(stream.fileno())
            if size == 0:
                raise BackupRejected(400, "Empty archive")
            os.replace(partial, path)
        except BaseException as exc:
            partial.unlink(missing_ok=True)
            self.db.execute("UPDATE backups SET status='failed', note=%s, completed_at=now() WHERE id=%s",
                            (str(exc)[:300] if isinstance(exc, BackupRejected) else "Upload interrupted", backup["id"]))
            raise
        return self.finish_upload(backup, path, size, digest.hexdigest())

    def finish_upload(self, backup: dict, path: Path, size: int, sha: str) -> dict:
        site = self.db.one("SELECT * FROM sites WHERE id=%s", (backup["site_id"],))
        config = self.db.one("SELECT * FROM site_backup_config WHERE site_id=%s", (site["id"],))
        destinations = self.db.query("SELECT * FROM backup_destinations WHERE enabled AND id = ANY(%s::uuid[])",
                                     (list(config["destination_ids"]) if config else [],))
        with self.db.transaction() as cur:
            cur.execute("UPDATE backups SET status='uploaded', size_bytes=%s, sha256=%s WHERE id=%s RETURNING *",
                        (size, sha, backup["id"]))
            backup = cur.fetchone()
            cur.execute("INSERT INTO backup_files(backup_id, stored_path, local_available) VALUES(%s,%s,true) "
                        "ON CONFLICT (backup_id) DO UPDATE SET stored_path=excluded.stored_path, local_available=true",
                        (backup["id"], path.name))
            for dest in destinations:
                cur.execute("INSERT INTO backup_transfers(backup_id, destination_id, remote_path) VALUES(%s,%s,%s)",
                            (backup["id"], dest["id"], self.remote_path(dest, site, backup["filename"])))
            if not destinations:
                cur.execute("UPDATE backups SET status='completed', completed_at=now(), note='Stored on hub only (no destinations)' "
                            "WHERE id=%s", (backup["id"],))
        self.app.state.realtime.publish({"type": "backup", "site_id": str(site["id"]), "backup_id": str(backup["id"]),
                                         "status": "uploaded"})
        return backup

    @staticmethod
    def site_folder(dest: dict, site: dict) -> str:
        parts = [p for p in (dest["folder"].strip("/"), site["slug"]) if p]
        return f"{dest['remote']}:{'/'.join(parts)}"

    def remote_path(self, dest: dict, site: dict, filename: str) -> str:
        return f"{self.site_folder(dest, site)}/{filename}"

    # -- transfers -----------------------------------------------------------------
    def run_due(self, limit: int = 4) -> int:
        """Process due transfers. Called repeatedly by the background task runner."""
        done = 0
        for _ in range(limit):
            with self.db.transaction() as cur:
                cur.execute("SELECT t.*, d.remote, d.folder, d.enabled FROM backup_transfers t JOIN backup_destinations d "
                            "ON d.id=t.destination_id WHERE t.status='queued' AND t.next_attempt_at <= now() "
                            "ORDER BY t.next_attempt_at FOR UPDATE OF t SKIP LOCKED LIMIT 1")
                job = cur.fetchone()
                if not job:
                    break
                cur.execute("UPDATE backup_transfers SET status='running' WHERE id=%s", (job["id"],))
            self._transfer(job)
            done += 1
        return done

    def _transfer(self, job: dict):
        backup = self.db.one("SELECT b.*, f.stored_path, f.local_available FROM backups b LEFT JOIN backup_files f "
                             "ON f.backup_id=b.id WHERE b.id=%s", (job["backup_id"],))
        path = self.root / (backup["stored_path"] or "") if backup else None
        if not job["enabled"]:
            ok, error = False, "Destination disabled"
            attempts = MAX_ATTEMPTS  # do not retry a disabled destination
        elif not backup or not backup["local_available"] or not path or not path.is_file():
            ok, error, attempts = False, "Local archive missing", MAX_ATTEMPTS
        else:
            ok, error = self.rclone.copy(path, job["remote_path"])
            attempts = job["attempts"] + 1
        if ok:
            self.db.execute("UPDATE backup_transfers SET status='completed', attempts=%s, error=NULL, completed_at=now() WHERE id=%s",
                            (job["attempts"] + 1, job["id"]))
            site = self.db.one("SELECT * FROM sites WHERE id=%s", (backup["site_id"],))
            self.prune(site, job)
        elif attempts >= MAX_ATTEMPTS:
            self.db.execute("UPDATE backup_transfers SET status='failed', attempts=%s, error=%s, completed_at=now() WHERE id=%s",
                            (attempts, error, job["id"]))
        else:
            delay = BACKOFF[min(attempts - 1, len(BACKOFF) - 1)]
            self.db.execute("UPDATE backup_transfers SET status='queued', attempts=%s, error=%s, next_attempt_at=%s WHERE id=%s",
                            (attempts, error, now() + timedelta(seconds=delay), job["id"]))
        self.aggregate(job["backup_id"])

    def aggregate(self, backup_id):
        rows = self.db.query("SELECT status FROM backup_transfers WHERE backup_id=%s", (backup_id,))
        states = {r["status"] for r in rows}
        if not rows or states & {"queued", "running"}:
            return
        status = "completed" if states == {"completed"} else "failed" if "completed" not in states else "partial"
        row = self.db.one("UPDATE backups SET status=%s, completed_at=now() WHERE id=%s AND status NOT IN ('completed','failed','partial') "
                          "RETURNING site_id", (status, backup_id))
        if row:
            if status == "completed":
                self._drop_local(backup_id)
            self.app.state.realtime.publish({"type": "backup", "site_id": str(row["site_id"]), "backup_id": str(backup_id),
                                             "status": status})

    def _drop_local(self, backup_id):
        row = self.db.one("SELECT stored_path FROM backup_files WHERE backup_id=%s AND local_available", (backup_id,))
        if row:
            (self.root / row["stored_path"]).unlink(missing_ok=True)
            self.db.execute("UPDATE backup_files SET local_available=false WHERE backup_id=%s", (backup_id,))

    def prune(self, site: dict, job: dict):
        config = self.db.one("SELECT keep_count FROM site_backup_config WHERE site_id=%s", (site["id"],))
        keep = config["keep_count"] if config else 14
        folder = self.site_folder(job, site)
        names = sorted(n for n in self.rclone.list_files(folder)
                       if n.startswith(site["slug"] + "-") and n.endswith(".tar.gz"))
        for name in names[:-keep] if len(names) > keep else []:
            if self.rclone.delete(f"{folder}/{name}"):
                LOG.info("Pruned %s/%s", folder, name)

    def retry(self, backup_id) -> int:
        count = self.db.execute("UPDATE backup_transfers t SET status='queued', attempts=0, error=NULL, next_attempt_at=now() "
                                "FROM backup_destinations d WHERE d.id=t.destination_id AND d.enabled "
                                "AND t.backup_id=%s AND t.status='failed'", (backup_id,))
        if count:
            self.db.execute("UPDATE backups SET status='uploaded', completed_at=NULL WHERE id=%s", (backup_id,))
        return count

    # -- housekeeping ----------------------------------------------------------------
    def housekeeping(self):
        cutoff = now() - timedelta(hours=LOCAL_KEEP_HOURS)
        for row in self.db.query("SELECT b.id FROM backups b JOIN backup_files f ON f.backup_id=b.id WHERE f.local_available "
                                 "AND b.status IN ('partial','failed') AND b.completed_at < %s", (cutoff,)):
            self._drop_local(row["id"])
        # Uploads interrupted by a hub restart.
        self.db.execute("UPDATE backups SET status='failed', note='Upload interrupted', completed_at=now() "
                        "WHERE status='uploading' AND created_at < now() - interval '6 hours'")
        self.db.execute("UPDATE backup_transfers SET status='queued', next_attempt_at=now() WHERE status='running' "
                        "AND backup_id IN (SELECT id FROM backups WHERE status='uploaded')")
        known = {r["stored_path"] for r in self.db.query("SELECT stored_path FROM backup_files WHERE local_available")}
        for path in self.root.glob("*"):
            if path.name not in known and path.is_file():
                age = now().timestamp() - path.stat().st_mtime
                if age > 6 * 3600:
                    path.unlink(missing_ok=True)

    def recover_on_start(self):
        self.db.execute("UPDATE backup_transfers SET status='queued', next_attempt_at=now() WHERE status='running'")


class BackupRejected(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message
