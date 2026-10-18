"""Opaque streaming staging and a durable, operator-configured rclone queue.

No archive parsing, cloud credentials in the API, or shell execution. SQLite
transactions reserve staging bytes and claim work; neither network reads nor
subprocess waits happen inside a transaction. A process lock prevents competing
workers from recovering each other's in-flight work in the same data directory.
"""

import asyncio
import errno
import fcntl
import hashlib
import json
import os
import re
import subprocess
import tempfile
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Annotated, Literal
from uuid import UUID, uuid4

import anyio
from fastapi import Depends, HTTPException, Request, Response
from fastapi.responses import FileResponse
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


MAX_DESTINATIONS = 100
MAX_TARGETS = 20
MAX_ACTIVE_PER_SITE = 100
MAX_ACTIVE_GLOBAL = 1000
MAX_UPLOADS_PER_SITE = 5
MAX_UPLOADS_GLOBAL = 20
MAX_CACHED_PER_SITE = 2000
MAX_CACHED_GLOBAL = 10000
MAX_METADATA_PER_SITE = 10000
MAX_METADATA_GLOBAL = 100000
UPLOAD_PERSISTENCE_THREADS = 8


def now():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def uid():
    return str(uuid4())


def bounded_env(name, default, maximum):
    raw = os.environ.get(name, str(default))
    if not re.fullmatch(r"[0-9]{1,20}", raw) or not 1 <= int(raw) <= maximum:
        raise RuntimeError(f"{name} must be a positive integer <= {maximum}")
    return int(raw)


def clean_text(value, maximum=500):
    return "".join(c for c in value if c.isprintable())[:maximum]


def safe_remote(value):
    # Deliberately narrower than rclone's grammar: never a path, URL, or flag.
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,99}", value):
        raise ValueError("Invalid remote name")
    return value


def safe_folder(value):
    if value == "":
        return value
    if len(value) > 500 or any(not c.isprintable() for c in value):
        raise ValueError("Invalid folder")
    if any(c in value for c in "\\:") or any(p in ("", ".", "..") or p.startswith("-") for p in value.split("/")):
        raise ValueError("Folder must be a relative POSIX path")
    return value


def safe_filename(value):
    if (not 1 <= len(value) <= 200 or value in (".", "..") or ".." in value
            or value.startswith("-") or any(c in value for c in "/\\:")
            or any(not c.isprintable() for c in value) or not value.strip()):
        raise HTTPException(422, "Invalid backup filename")
    return value


async def upload_chunks(request, idle_timeout=60, total_timeout=3600):
    """Bound both slow-drip and abandoned uploads, including chunked requests."""
    deadline = time.monotonic() + total_timeout
    iterator = request.stream().__aiter__()
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise HTTPException(408, "Backup upload duration exceeded")
        try:
            chunk = await asyncio.wait_for(iterator.__anext__(), timeout=min(idle_timeout, remaining))
        except StopAsyncIteration:
            return
        except TimeoutError:
            raise HTTPException(408, "Backup upload timed out") from None
        yield chunk


class Model(BaseModel):
    model_config = ConfigDict(extra="forbid")


class DestinationCreate(Model):
    name: str = Field(min_length=1, max_length=200)
    remote: str
    folder: str = ""
    enabled: bool = Field(default=True, strict=True)

    @field_validator("name")
    @classmethod
    def name_valid(cls, value):
        if not value.strip() or any(not c.isprintable() for c in value):
            raise ValueError("Invalid name")
        return value.strip()

    @field_validator("remote")
    @classmethod
    def remote_valid(cls, value):
        return safe_remote(value)

    @field_validator("folder")
    @classmethod
    def folder_valid(cls, value):
        return safe_folder(value)


class DestinationPatch(DestinationCreate):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    remote: str | None = None
    folder: str | None = None
    enabled: bool | None = Field(default=None, strict=True)

    @model_validator(mode="before")
    @classmethod
    def not_null(cls, values):
        if isinstance(values, dict) and any(v is None for v in values.values()):
            raise ValueError("Fields cannot be null")
        return values


class ConfigInput(Model):
    enabled: bool = Field(strict=True)
    interval_minutes: int = Field(default=1440, ge=15, le=43200, strict=True)
    destination_ids: list[UUID] = Field(max_length=MAX_TARGETS)

    @model_validator(mode="after")
    def unique_targets(self):
        if len(set(self.destination_ids)) != len(self.destination_ids):
            raise ValueError("Duplicate destinations")
        if self.enabled and not self.destination_ids:
            raise ValueError("Enabled backups require a destination")
        return self


class StatusInput(Model):
    configured: bool = Field(strict=True)
    next_backup_at: datetime | None = None

    @field_validator("next_backup_at")
    @classmethod
    def timezone_required(cls, value):
        if value is not None and value.tzinfo is None:
            raise ValueError("Timestamp requires timezone")
        return value


class FailedAck(Model):
    status: Literal["failed"]
    message: str | None = Field(default=None, max_length=4000)


SCHEMA = """
CREATE TABLE IF NOT EXISTS backup_destinations (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, remote TEXT NOT NULL,
 folder TEXT NOT NULL, enabled INTEGER NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS backup_configs (
 site_id TEXT PRIMARY KEY REFERENCES sites(id) ON DELETE CASCADE,
 enabled INTEGER NOT NULL DEFAULT 0, interval_minutes INTEGER NOT NULL DEFAULT 1440,
 agent_configured INTEGER NOT NULL DEFAULT 0, agent_last_seen TEXT, next_backup_at TEXT
);
CREATE TABLE IF NOT EXISTS backup_targets (
 site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
 destination_id TEXT NOT NULL REFERENCES backup_destinations(id),
 PRIMARY KEY(site_id,destination_id)
);
CREATE TABLE IF NOT EXISTS backup_requests (
 id TEXT PRIMARY KEY, site_id TEXT NOT NULL REFERENCES sites(id),
 status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL,
 completed_at TEXT, message TEXT, backup_id TEXT, targets TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS backups (
 id TEXT PRIMARY KEY, site_id TEXT NOT NULL REFERENCES sites(id), filename TEXT NOT NULL,
 size_bytes INTEGER NOT NULL DEFAULT 0, sha256 TEXT, status TEXT NOT NULL,
 source TEXT NOT NULL, created_at TEXT NOT NULL, completed_at TEXT,
 local_available INTEGER NOT NULL DEFAULT 0, error TEXT, request_id TEXT
);
CREATE TABLE IF NOT EXISTS backup_transfers (
 id TEXT PRIMARY KEY, backup_id TEXT NOT NULL REFERENCES backups(id),
 destination_id TEXT NOT NULL, destination_name TEXT NOT NULL,
 remote TEXT NOT NULL, folder TEXT NOT NULL, remote_path TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'queued', attempts INTEGER NOT NULL DEFAULT 0,
 error TEXT, completed_at TEXT, next_attempt REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS backup_site_time ON backups(site_id,created_at DESC);
CREATE INDEX IF NOT EXISTS backup_request_site ON backup_requests(site_id,status);
CREATE INDEX IF NOT EXISTS backup_transfer_queue ON backup_transfers(status,next_attempt);
"""


class Backups:
    def __init__(self, store, data_dir):
        self.store = store
        self.root = Path(data_dir) / "backup-cache"
        if self.root.is_symlink():
            raise RuntimeError("Backup cache must not be a symlink")
        self.root.mkdir(mode=0o700, exist_ok=True)
        os.chmod(self.root, 0o700)
        self.binary = os.environ.get("HUB_RCLONE_BINARY", "rclone")
        self.config = os.environ.get("HUB_RCLONE_CONFIG", str(Path(data_dir) / "rclone.conf"))
        if not self.binary or not self.config or "\0" in self.binary + self.config:
            raise RuntimeError("Invalid rclone configuration")
        self.max_upload = bounded_env("HUB_BACKUP_MAX_UPLOAD_BYTES", 1073741824, 2**50)
        self.max_storage = bounded_env("HUB_BACKUP_MAX_STORAGE_BYTES", 10737418240, 2**60)
        self.retention = bounded_env("HUB_BACKUP_RETENTION_DAYS", 7, 36500)
        self.timeout = bounded_env("HUB_BACKUP_TRANSFER_TIMEOUT_SECONDS", 3600, 86400)
        enabled = os.environ.get("HUB_BACKUP_WORKER_ENABLED", "true").lower()
        if enabled not in ("true", "false"):
            raise RuntimeError("HUB_BACKUP_WORKER_ENABLED must be true or false")
        self.enabled = enabled == "true"
        self.stop_event = threading.Event()
        self.wake = threading.Event()
        self.thread = None
        self.process = None
        self.process_lock = threading.Lock()
        self.file_lock = threading.RLock()
        self.downloads = {}
        self.worker_lock = None
        self.pending_result = None
        self.upload_limiter = anyio.CapacityLimiter(UPLOAD_PERSISTENCE_THREADS)
        with store.transaction() as db:
            db.executescript(SCHEMA)

    def path(self, backup_id, partial=False):
        return self.root / (str(UUID(backup_id)) + (".part" if partial else ".blob"))

    def site(self, db, site_id):
        if not db.execute("SELECT 1 FROM sites WHERE id=?", (site_id,)).fetchone():
            raise HTTPException(404, "Site not found")

    def guard_site_deletion(self, db, site_id):
        # Caller owns file_lock BEFORE opening the database transaction.
        rows = db.execute("SELECT id,status FROM backups WHERE site_id=?", (site_id,)).fetchall()
        if any(r["status"] in ("uploading", "queued", "transferring") or self.downloads.get(r["id"]) for r in rows):
            raise HTTPException(409, "Site has active backups or downloads; wait for transfers to finish before deleting")
        for row in rows:
            self.path(row["id"]).unlink(missing_ok=True)
            self.path(row["id"], True).unlink(missing_ok=True)
            db.execute("DELETE FROM backup_transfers WHERE backup_id=?", (row["id"],))
        db.execute("DELETE FROM backup_requests WHERE site_id=?", (site_id,))
        db.execute("DELETE FROM backups WHERE site_id=?", (site_id,))

    def config_output(self, db, site_id):
        self.site(db, site_id)
        row = db.execute("SELECT * FROM backup_configs WHERE site_id=?", (site_id,)).fetchone()
        return {"enabled": bool(row["enabled"]) if row else False,
                "interval_minutes": row["interval_minutes"] if row else 1440,
                "destination_ids": [r[0] for r in db.execute("SELECT destination_id FROM backup_targets WHERE site_id=? ORDER BY destination_id", (site_id,))],
                "agent_configured": bool(row["agent_configured"]) if row else False,
                "agent_last_seen": row["agent_last_seen"] if row else None,
                "next_backup_at": row["next_backup_at"] if row else None}

    def targets(self, db, site_id):
        return [dict(r) for r in db.execute("SELECT d.* FROM backup_destinations d JOIN backup_targets t ON t.destination_id=d.id WHERE t.site_id=? AND d.enabled=1 ORDER BY d.id", (site_id,))]

    def validate_targets(self, db, targets):
        if not targets:
            raise HTTPException(409, "Select at least one enabled backup destination")
        if len(targets) > MAX_TARGETS:
            raise HTTPException(409, "A backup may select at most 20 destinations")
        for target in targets:
            row = db.execute("SELECT enabled FROM backup_destinations WHERE id=?", (target["id"],)).fetchone()
            if row is None or not row[0]:
                raise HTTPException(409, "Backup destination is unavailable or disabled")

    def check_queue_capacity(self, db, site_id, uploading=False):
        # The caller's transaction serializes checking with inserting/activating
        # the reservation. Empty files consume these slots just like any file.
        row = db.execute(
            "SELECT COUNT(*),COALESCE(SUM(site_id=?),0),"
            "COALESCE(SUM(status='uploading'),0),"
            "COALESCE(SUM(site_id=? AND status='uploading'),0) "
            "FROM backups WHERE status IN ('uploading','queued','transferring')",
            (site_id, site_id),
        ).fetchone()
        if uploading and (row[2] >= MAX_UPLOADS_GLOBAL or row[3] >= MAX_UPLOADS_PER_SITE):
            raise HTTPException(429, "Concurrent backup upload limit reached; try again later", headers={"Retry-After": "60"})
        if row[0] >= MAX_ACTIVE_GLOBAL or row[1] >= MAX_ACTIVE_PER_SITE:
            raise HTTPException(409, "Active backup queue limit reached; wait for transfers to finish")

    def used(self, db):
        return db.execute("SELECT COALESCE(SUM(size_bytes),0) FROM backups WHERE local_available=1 OR status='uploading'").fetchone()[0]

    def cached_counts(self, db, site_id=None):
        return db.execute(
            "SELECT COUNT(*),COALESCE(SUM(site_id=?),0) FROM backups WHERE local_available=1 OR status='uploading'",
            (site_id,),
        ).fetchone()

    def check_metadata_capacity(self, db, site_id):
        # Count requests too: repeatedly failing requests must not bypass limits.
        while True:
            row = db.execute(
                "SELECT COUNT(*),COALESCE(SUM(site_id=?),0) FROM "
                "(SELECT site_id FROM backups UNION ALL SELECT site_id FROM backup_requests)", (site_id,),
            ).fetchone()
            if row[0] < MAX_METADATA_GLOBAL and row[1] < MAX_METADATA_PER_SITE:
                return
            scope = site_id if row[1] >= MAX_METADATA_PER_SITE else None
            if not self.prune_metadata(db, scope):
                raise HTTPException(409, "Backup history limit reached; evict terminal cached backups to allow history cleanup, or delete inactive sites")

    def prune_metadata(self, db, site_id):
        # No filesystem/cloud operations here. Only unavailable terminal records
        # without active transfers or pending/delivered request references qualify.
        rows = db.execute("""
            SELECT id,kind FROM (
              SELECT b.id,b.created_at,'backup' AS kind FROM backups b
              WHERE b.status IN ('completed','partial','failed') AND b.local_available=0
                AND (? IS NULL OR b.site_id=?)
                AND NOT EXISTS (SELECT 1 FROM backup_transfers t WHERE t.backup_id=b.id AND t.status IN ('queued','transferring'))
                AND NOT EXISTS (SELECT 1 FROM backup_requests r WHERE r.status IN ('pending','delivered') AND (r.backup_id=b.id OR r.id=b.request_id))
              UNION ALL
              SELECT r.id,r.created_at,'request' AS kind FROM backup_requests r
              WHERE r.status IN ('uploaded','failed') AND (? IS NULL OR r.site_id=?)
                AND NOT EXISTS (SELECT 1 FROM backups b WHERE b.id=r.backup_id OR b.request_id=r.id)
            ) ORDER BY created_at,id LIMIT 100
        """, (site_id, site_id, site_id, site_id)).fetchall()
        pruned = False
        for row in rows:
            if row["kind"] == "backup":
                if self.path(row["id"]).exists() or self.path(row["id"], True).exists():
                    continue
                backup = db.execute("SELECT request_id FROM backups WHERE id=?", (row["id"],)).fetchone()
                if backup is None:
                    continue
                requests = db.execute("SELECT id FROM backup_requests WHERE status IN ('uploaded','failed') AND (backup_id=? OR (id=? AND backup_id IS NULL))", (row["id"], backup[0])).fetchall()
                for request in requests:
                    db.execute("UPDATE backups SET request_id=NULL WHERE request_id=?", (request[0],))
                    db.execute("DELETE FROM backup_requests WHERE id=?", (request[0],))
                db.execute("DELETE FROM backup_transfers WHERE backup_id=?", (row["id"],))
                db.execute("DELETE FROM backups WHERE id=?", (row["id"],))
            else:
                db.execute("DELETE FROM backup_requests WHERE id=?", (row["id"],))
            pruned = True
        return pruned

    def check_artifact_capacity(self, db, site_id):
        counts = self.cached_counts(db, site_id)
        if counts[0] >= MAX_CACHED_GLOBAL or counts[1] >= MAX_CACHED_PER_SITE:
            raise HTTPException(409, "Backup cache file limit reached; evict terminal cached backups or wait for retention cleanup")

    async def persist(self, operation, *args):
        """Bounded off-loop persistence, never abandoned while touching a file.

        AnyIO shields ordinary server cancellation. Shield/drain also handles
        native asyncio Task.cancel(), so cleanup cannot race a still-running
        reservation/write/commit. Callers own state and clean up in finally.
        """
        async def run():
            with anyio.CancelScope(shield=True):
                return await anyio.to_thread.run_sync(operation, *args, abandon_on_cancel=False, limiter=self.upload_limiter)

        task = asyncio.create_task(run())
        try:
            return await asyncio.shield(task)
        except asyncio.CancelledError:
            with anyio.CancelScope(shield=True):
                while not task.done():
                    try:
                        await asyncio.shield(task)
                    except asyncio.CancelledError:
                        pass
                    except BaseException:
                        break
                if not task.cancelled():
                    task.exception()  # Retrieve worker errors; cancellation wins.
            raise

    def backup_row(self, db, site_id, backup_id):
        row = db.execute("SELECT * FROM backups WHERE id=? AND site_id=?", (backup_id, site_id)).fetchone()
        if row is None:
            raise HTTPException(404, "Backup not found")
        return row

    def backup_output(self, db, row):
        result = {k: row[k] for k in ("id", "site_id", "filename", "size_bytes", "sha256", "status", "source", "created_at", "completed_at", "error")}
        result["local_available"] = bool(row["local_available"]) and self.path(row["id"]).is_file()
        fields = ("id", "destination_id", "destination_name", "status", "attempts", "error", "completed_at", "remote_path")
        result["transfers"] = [{k: r[k] for k in fields} for r in db.execute("SELECT * FROM backup_transfers WHERE backup_id=? ORDER BY rowid", (row["id"],))]
        return result

    @staticmethod
    def request_output(row):
        return {k: row[k] for k in ("id", "site_id", "status", "created_at", "completed_at", "message", "backup_id")}

    def remotes(self):
        try:
            # Spool operator-controlled output rather than accumulating it in RAM.
            with tempfile.TemporaryFile(dir=self.root) as output:
                result = subprocess.run([self.binary, "listremotes", "--config", self.config],
                                        stdout=output, stderr=subprocess.DEVNULL, timeout=10, check=False)
                output.seek(0)
                content = output.read(65537)
            if result.returncode != 0 or len(content) > 65536:
                raise ValueError()
            names = []
            for line in content.decode("utf-8").splitlines():
                if line.endswith(":"):
                    try:
                        names.append(safe_remote(line[:-1]))
                    except ValueError:
                        continue
            return {"available": True, "remotes": sorted(set(names)), "message": None}
        except (OSError, ValueError, subprocess.TimeoutExpired, UnicodeError):
            return {"available": False, "remotes": [], "message": "rclone remotes unavailable; ask the operator to check the rclone configuration"}

    def require_remote(self, remote):
        result = self.remotes()
        if not result["available"]:
            raise HTTPException(503, result["message"])
        if remote not in result["remotes"]:
            raise HTTPException(422, "Remote is not configured in rclone")

    def aggregate(self, db, backup_id):
        rows = db.execute("SELECT status FROM backup_transfers WHERE backup_id=?", (backup_id,)).fetchall()
        statuses = [r[0] for r in rows]
        if "transferring" in statuses:
            status = "transferring"
        elif "queued" in statuses:
            status = "queued"
        elif statuses and all(s == "completed" for s in statuses):
            status = "completed"
        elif "completed" in statuses:
            status = "partial"
        else:
            status = "failed"
        terminal = status in ("completed", "partial", "failed")
        error = "One or more cloud transfers failed" if status in ("partial", "failed") else None
        db.execute("UPDATE backups SET status=?,completed_at=?,error=? WHERE id=?", (status, now() if terminal else None, error, backup_id))

    def start(self):
        if not self.enabled or self.thread is not None:
            return
        fd = os.open(self.root / ".worker.lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            os.close(fd)
            raise RuntimeError("A backup worker is already running for this data directory") from None
        self.worker_lock = fd
        try:
            self.recover()
            self.stop_event.clear()
            self.thread = threading.Thread(target=self.run, name="hub-backup-worker", daemon=True)
            self.thread.start()
        except BaseException:
            os.close(fd)
            self.worker_lock = None
            raise

    def stop(self):
        self.stop_event.set()
        self.wake.set()
        with self.process_lock:
            if self.process is not None and self.process.poll() is None:
                try:
                    self.process.terminate()
                except ProcessLookupError:
                    pass
        if self.thread is not None:
            self.thread.join(timeout=15)
            if self.thread.is_alive():
                raise RuntimeError("Backup worker did not stop")
            self.thread = None
        if self.worker_lock is not None:
            os.close(self.worker_lock)
            self.worker_lock = None

    def recover(self):
        # Only startup calls this: never fail another live upload during a request.
        for path in self.root.glob("*.result"):
            with path.open("rb") as stream:
                result = json.loads(stream.read(4097))
            row = {"id": str(UUID(result["id"])), "backup_id": str(UUID(result["backup_id"])), "attempts": result["attempts"]}
            if path.stem != row["id"] or type(row["attempts"]) is not int or not 0 <= row["attempts"] <= 3:
                raise RuntimeError("Invalid backup result journal")
            if type(result["success"]) is not bool or type(result["interrupted"]) is not bool:
                raise RuntimeError("Invalid backup result journal")
            self.pending_result = (row, result["success"], clean_text(result["error"]), result["interrupted"])
            self.finalize_result()
        with self.file_lock, self.store.transaction() as db:
            for row in db.execute("SELECT * FROM backups WHERE status='uploading'").fetchall():
                self.path(row["id"], True).unlink(missing_ok=True)
                self.path(row["id"]).unlink(missing_ok=True)
                db.execute("UPDATE backups SET status='failed',size_bytes=0,local_available=0,error='Upload interrupted before completion',completed_at=? WHERE id=?", (now(), row["id"]))
                if row["request_id"]:
                    db.execute("UPDATE backup_requests SET status='failed',message='Upload interrupted before completion',completed_at=? WHERE id=?", (now(), row["request_id"]))
            db.execute("UPDATE backup_transfers SET status='queued',next_attempt=0,error=NULL WHERE status='transferring'")
            for row in db.execute("SELECT * FROM backups WHERE status!='uploading'").fetchall():
                if row["local_available"] and not self.path(row["id"]).is_file():
                    db.execute("UPDATE backups SET local_available=0 WHERE id=?", (row["id"],))
                if row["status"] in ("queued", "transferring"):
                    if not self.path(row["id"]).is_file():
                        db.execute("UPDATE backup_transfers SET status='failed',error='Cached artifact is missing',completed_at=? WHERE backup_id=? AND status!='completed'", (now(), row["id"]))
                    self.aggregate(db, row["id"])
            # A crash during cleanup/rename may leave files belonging to a
            # terminal, unavailable row. They must not escape quota accounting.
            kept = {r[0] for r in db.execute("SELECT id FROM backups WHERE local_available=1")}
            for path in self.root.glob("*.result.part"):
                try:
                    UUID(path.name.removesuffix(".result.part"))
                except ValueError:
                    continue
                path.unlink(missing_ok=True)
            for path in self.root.glob("*.part"):
                try:
                    UUID(path.stem)
                except ValueError:
                    continue
                path.unlink(missing_ok=True)
            for path in self.root.glob("*.blob"):
                try:
                    UUID(path.stem)
                except ValueError:
                    continue
                if path.stem not in kept:
                    path.unlink(missing_ok=True)

    def retain(self):
        cutoff = time.time() - self.retention * 86400
        with self.file_lock, self.store.transaction() as db:
            for row in db.execute("SELECT id,completed_at FROM backups WHERE status='completed' AND local_available=1").fetchall():
                if (row["completed_at"] and datetime.fromisoformat(row["completed_at"].replace("Z", "+00:00")).timestamp() < cutoff
                        and not self.downloads.get(row["id"])):
                    self.path(row["id"]).unlink(missing_ok=True)
                    db.execute("UPDATE backups SET local_available=0 WHERE id=?", (row["id"],))

    def run(self):
        while not self.stop_event.is_set():
            try:
                if self.pending_result is not None:
                    self.transfer_one()
                    continue
                self.retain()
                if self.transfer_one():
                    continue
            except Exception:
                # A temporary filesystem/SQLite fault must not kill the durable worker.
                # Never log subprocess output (it can contain credentials).
                import logging
                logging.getLogger(__name__).warning("Backup worker operation failed; will retry")
            self.wake.wait(1)
            self.wake.clear()

    def transfer_one(self):
        # A finished subprocess must never be copied again merely because SQLite
        # was temporarily unavailable. Drain its outcome before claiming any job.
        if self.pending_result is not None:
            self.finalize_result()
            return True
        with self.file_lock, self.store.transaction() as db:
            row = db.execute("SELECT t.*,b.site_id FROM backup_transfers t JOIN backups b ON b.id=t.backup_id WHERE t.status='queued' AND t.next_attempt<=? ORDER BY t.rowid LIMIT 1", (time.time(),)).fetchone()
            if row is None:
                return False
            row = dict(row)
            dest = db.execute("SELECT enabled FROM backup_destinations WHERE id=?", (row["destination_id"],)).fetchone()
            error = None
            if dest is None or not dest[0]:
                error = "Destination disabled or removed; enable it and retry"
            elif not self.path(row["backup_id"]).is_file():
                error = "Cached artifact is missing"
                db.execute("UPDATE backups SET local_available=0 WHERE id=?", (row["backup_id"],))
            elif row["attempts"] >= 3:
                error = "Automatic transfer attempts exhausted; retry manually"
            if error:
                db.execute("UPDATE backup_transfers SET status='failed',error=?,completed_at=? WHERE id=?", (error, now(), row["id"]))
                self.aggregate(db, row["backup_id"])
                return True
            db.execute("UPDATE backup_transfers SET status='transferring',attempts=attempts+1,error=NULL WHERE id=?", (row["id"],))
            self.aggregate(db, row["backup_id"])
        success, error = False, "Cloud transfer failed; check operator rclone configuration"
        process = None
        try:
            with self.process_lock:
                if not self.stop_event.is_set():
                    process = subprocess.Popen([
                        self.binary, "copyto", str(self.path(row["backup_id"])),
                        row["remote"] + ":" + row["remote_path"],
                        "--config", self.config, "--retries", "1", "--low-level-retries", "1",
                        "--contimeout", "30s", "--timeout", "60s", "--quiet",
                    ], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                    self.process = process
            if process is not None:
                deadline = time.monotonic() + self.timeout
                while not self.stop_event.is_set() and time.monotonic() < deadline:
                    try:
                        success = process.wait(timeout=min(0.25, max(0.001, deadline - time.monotonic()))) == 0
                        break
                    except subprocess.TimeoutExpired:
                        pass
                else:
                    error = "Cloud transfer timed out" if not self.stop_event.is_set() else "Transfer interrupted by shutdown"
                    process.terminate()
                    try:
                        process.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait()
        except OSError:
            error = "Unable to start rclone; ask the operator to check installation"
        finally:
            with self.process_lock:
                self.process = None
        self.pending_result = (row, success, error, self.stop_event.is_set())
        self.finalize_result()
        return True

    def finalize_result(self):
        row, success, error, interrupted = self.pending_result
        journal = self.root / (str(UUID(row["id"])) + ".result")
        if not journal.exists():
            temporary = journal.with_suffix(".result.part")
            fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
            with os.fdopen(fd, "w") as stream:
                json.dump({"id": row["id"], "backup_id": row["backup_id"], "attempts": row["attempts"],
                           "success": success, "error": error, "interrupted": interrupted}, stream)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, journal)
            self.sync_directory()
        with self.store.transaction() as db:
            if success:
                db.execute("UPDATE backup_transfers SET status='completed',error=NULL,completed_at=? WHERE id=?", (now(), row["id"]))
            elif interrupted:
                db.execute("UPDATE backup_transfers SET status='queued',next_attempt=0 WHERE id=?", (row["id"],))
            elif row["attempts"] + 1 < 3:
                db.execute("UPDATE backup_transfers SET status='queued',error=?,next_attempt=? WHERE id=?", (error, time.time() + min(300, 5 * 2 ** row["attempts"]), row["id"]))
            else:
                db.execute("UPDATE backup_transfers SET status='failed',error=?,completed_at=? WHERE id=?", (error, now(), row["id"]))
            self.aggregate(db, row["backup_id"])
        # Only clear after COMMIT. Retrying an ambiguously successful commit is
        # idempotent; attempts are incremented at claim time, not finalization.
        journal.unlink(missing_ok=True)
        self.sync_directory()
        self.pending_result = None

    def sync_directory(self):
        fd = os.open(self.root, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)


class UploadSession:
    """Sequential synchronous operations; the route calls these only via persist.

    Session state survives cancellation of an awaiting route, allowing its finally
    block to clean a reservation even if cancellation arrived during begin().
    """
    def __init__(self, service, site_id, filename, request_id, source, expected):
        self.service, self.site_id, self.filename = service, site_id, filename
        self.request_id = str(request_id) if request_id else None
        self.source, self.expected = source, expected
        self.id = uid()
        self.partial, self.complete = service.path(self.id, True), service.path(self.id)
        self.digest, self.size = hashlib.sha256(), 0
        self.reserved, self.published, self.stream = False, False, None

    def begin(self):
        service = self.service
        with service.store.transaction() as db:
            service.site(db, self.site_id)
            service.check_queue_capacity(db, self.site_id, uploading=True)
            service.check_artifact_capacity(db, self.site_id)
            service.check_metadata_capacity(db, self.site_id)
            if self.request_id:
                row = db.execute("SELECT * FROM backup_requests WHERE id=? AND site_id=?", (self.request_id, self.site_id)).fetchone()
                if row is None:
                    raise HTTPException(404, "Backup request not found")
                if row["status"] not in ("pending", "delivered") or row["backup_id"]:
                    raise HTTPException(409, "Backup request already claimed or terminal")
                self.targets = json.loads(row["targets"])
            else:
                self.targets = service.targets(db, self.site_id)
            service.validate_targets(db, self.targets)
            if self.expected is not None and service.used(db) + self.expected > service.max_storage:
                raise HTTPException(507, "Backup staging storage exhausted")
            db.execute("INSERT INTO backups(id,site_id,filename,status,source,created_at,request_id) VALUES(?,?,?,'uploading',?,?,?)", (self.id, self.site_id, self.filename, self.source, now(), self.request_id))
            if self.request_id:
                db.execute("UPDATE backup_requests SET backup_id=? WHERE id=?", (self.id, self.request_id))
        self.reserved = True
        fd = os.open(self.partial, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        self.stream = os.fdopen(fd, "wb")

    def write(self, chunk):
        service = self.service
        if self.size + len(chunk) > service.max_upload:
            raise HTTPException(413, "Backup exceeds per-file quota")
        with service.store.transaction() as db:
            if service.used(db) + len(chunk) > service.max_storage:
                raise HTTPException(507, "Backup staging storage exhausted")
            db.execute("UPDATE backups SET size_bytes=? WHERE id=?", (self.size + len(chunk), self.id))
        self.stream.write(chunk)
        self.digest.update(chunk)
        self.size += len(chunk)

    def finish(self):
        service = self.service
        if self.expected is not None and self.size != self.expected:
            raise HTTPException(400, "Content-Length did not match uploaded bytes")
        self.stream.flush()
        os.fsync(self.stream.fileno())
        self.stream.close()
        self.stream = None
        os.replace(self.partial, self.complete)
        service.sync_directory()
        with service.store.transaction() as db:
            db.execute("UPDATE backups SET sha256=?,size_bytes=?,status='queued',local_available=1 WHERE id=?", (self.digest.hexdigest(), self.size, self.id))
            for target in self.targets:
                remote_path = "/".join(p for p in (target["folder"], self.site_id, self.id, self.filename) if p)
                db.execute("INSERT INTO backup_transfers(id,backup_id,destination_id,destination_name,remote,folder,remote_path) VALUES(?,?,?,?,?,?,?)", (uid(), self.id, target["id"], target["name"], target["remote"], target["folder"], remote_path))
            if self.request_id:
                db.execute("UPDATE backup_requests SET status='uploaded',completed_at=?,message=NULL WHERE id=?", (now(), self.request_id))
            result = service.backup_output(db, service.backup_row(db, self.site_id, self.id))
        self.published = True
        service.wake.set()
        return result

    def abort(self):
        if self.published or not self.reserved:
            return
        try:
            if self.stream is not None:
                self.stream.close()
        finally:
            self.stream = None
            self.partial.unlink(missing_ok=True)
            self.complete.unlink(missing_ok=True)
            with self.service.store.transaction() as db:
                db.execute("UPDATE backups SET status='failed',size_bytes=0,local_available=0,error='Upload did not complete',completed_at=? WHERE id=?", (now(), self.id))
                if self.request_id:
                    db.execute("UPDATE backup_requests SET backup_id=NULL WHERE id=? AND status IN ('pending','delivered')", (self.request_id,))


def install_backups(app, store, admin, agent, data_dir):
    service = Backups(store, data_dir)
    app.state.backups = service
    app.add_event_handler("startup", service.start)
    app.add_event_handler("shutdown", service.stop)
    admin_deps = [Depends(admin)]

    @app.get("/api/backup-remotes", dependencies=admin_deps)
    def remotes():
        return service.remotes()

    @app.get("/api/backup-storage", dependencies=admin_deps)
    def storage():
        with store.transaction() as db:
            return {"used_bytes": service.used(db), "max_bytes": service.max_storage,
                    "max_upload_bytes": service.max_upload, "retention_days": service.retention,
                    "cached_files": service.cached_counts(db)[0], "max_cached_files": MAX_CACHED_GLOBAL}

    def destination_output(row):
        return {**dict(row), "enabled": bool(row["enabled"])}

    @app.get("/api/backup-destinations", dependencies=admin_deps)
    def destinations():
        with store.transaction() as db:
            return [destination_output(r) for r in db.execute("SELECT * FROM backup_destinations ORDER BY created_at,id")]

    @app.post("/api/backup-destinations", dependencies=admin_deps, status_code=201)
    def add_destination(body: DestinationCreate):
        service.require_remote(body.remote)
        destination_id = uid()
        with store.transaction() as db:
            if db.execute("SELECT COUNT(*) FROM backup_destinations").fetchone()[0] >= MAX_DESTINATIONS:
                raise HTTPException(409, "Destination limit reached")
            db.execute("INSERT INTO backup_destinations VALUES(?,?,?,?,?,?)", (destination_id, body.name, body.remote, body.folder, body.enabled, now()))
            return destination_output(db.execute("SELECT * FROM backup_destinations WHERE id=?", (destination_id,)).fetchone())

    @app.patch("/api/backup-destinations/{destination_id}", dependencies=admin_deps)
    def patch_destination(destination_id: UUID, body: DestinationPatch):
        values = body.model_dump(exclude_unset=True)
        if "remote" in values:
            service.require_remote(values["remote"])
        with store.transaction() as db:
            row = db.execute("SELECT * FROM backup_destinations WHERE id=?", (str(destination_id),)).fetchone()
            if row is None:
                raise HTTPException(404, "Destination not found")
            merged = {**dict(row), **values}
            db.execute("UPDATE backup_destinations SET name=?,remote=?,folder=?,enabled=? WHERE id=?", (merged["name"], merged["remote"], merged["folder"], merged["enabled"], str(destination_id)))
            return destination_output(db.execute("SELECT * FROM backup_destinations WHERE id=?", (str(destination_id),)).fetchone())

    @app.delete("/api/backup-destinations/{destination_id}", dependencies=admin_deps, status_code=204)
    def delete_destination(destination_id: UUID):
        key = str(destination_id)
        with store.transaction() as db:
            if not db.execute("SELECT 1 FROM backup_destinations WHERE id=?", (key,)).fetchone():
                raise HTTPException(404, "Destination not found")
            if (db.execute("SELECT 1 FROM backup_targets WHERE destination_id=?", (key,)).fetchone()
                    or db.execute("SELECT 1 FROM backup_transfers WHERE destination_id=? AND status IN ('queued','transferring')", (key,)).fetchone()):
                raise HTTPException(409, "Destination is selected by a site or has active transfers")
            # Pending request snapshots also reserve a destination.
            for row in db.execute("SELECT targets FROM backup_requests WHERE status IN ('pending','delivered')"):
                if any(t["id"] == key for t in json.loads(row[0])):
                    raise HTTPException(409, "Destination is reserved by a pending backup request")
            db.execute("DELETE FROM backup_destinations WHERE id=?", (key,))
        return Response(status_code=204)

    def get_config(site_id):
        with store.transaction() as db:
            return service.config_output(db, str(site_id))

    @app.get("/api/sites/{site_id}/backup-config", dependencies=admin_deps)
    def admin_config(site_id: UUID):
        return get_config(site_id)

    @app.get("/api/agent/backup-config")
    def agent_config(site_id: Annotated[str, Depends(agent)]):
        return get_config(site_id)

    @app.put("/api/sites/{site_id}/backup-config", dependencies=admin_deps)
    def put_config(site_id: UUID, body: ConfigInput):
        key = str(site_id)
        with store.transaction() as db:
            service.site(db, key)
            if body.destination_ids:
                service.validate_targets(db, [{"id": str(d)} for d in body.destination_ids])
            db.execute("INSERT INTO backup_configs(site_id,enabled,interval_minutes) VALUES(?,?,?) ON CONFLICT(site_id) DO UPDATE SET enabled=excluded.enabled,interval_minutes=excluded.interval_minutes", (key, body.enabled, body.interval_minutes))
            db.execute("DELETE FROM backup_targets WHERE site_id=?", (key,))
            db.executemany("INSERT INTO backup_targets VALUES(?,?)", [(key, str(d)) for d in body.destination_ids])
            return service.config_output(db, key)

    @app.post("/api/agent/backup-status")
    def agent_status(body: StatusInput, site_id: Annotated[str, Depends(agent)]):
        next_at = body.next_backup_at.astimezone(timezone.utc).isoformat().replace("+00:00", "Z") if body.next_backup_at else None
        with store.transaction() as db:
            service.site(db, site_id)
            db.execute("INSERT INTO backup_configs(site_id,agent_configured,agent_last_seen,next_backup_at) VALUES(?,?,?,?) ON CONFLICT(site_id) DO UPDATE SET agent_configured=excluded.agent_configured,agent_last_seen=excluded.agent_last_seen,next_backup_at=excluded.next_backup_at", (site_id, body.configured, now(), next_at))
        return {"status": "ok"}

    @app.post("/api/sites/{site_id}/backups/request", dependencies=admin_deps, status_code=201)
    def request_backup(site_id: UUID, body: Model):
        key, request_id = str(site_id), uid()
        with store.transaction() as db:
            service.site(db, key)
            service.check_metadata_capacity(db, key)
            targets = service.targets(db, key)
            service.validate_targets(db, targets)
            if db.execute("SELECT COUNT(*) FROM backup_requests WHERE site_id=? AND status IN ('pending','delivered')", (key,)).fetchone()[0] >= 20:
                raise HTTPException(409, "Pending backup request limit of 20 reached")
            db.execute("INSERT INTO backup_requests(id,site_id,created_at,targets) VALUES(?,?,?,?)", (request_id, key, now(), json.dumps(targets)))
            return service.request_output(db.execute("SELECT * FROM backup_requests WHERE id=?", (request_id,)).fetchone())

    @app.get("/api/agent/backup-requests")
    def poll_requests(site_id: Annotated[str, Depends(agent)]):
        with store.transaction() as db:
            db.execute("UPDATE backup_requests SET status='delivered' WHERE site_id=? AND status='pending'", (site_id,))
            return [service.request_output(r) for r in db.execute("SELECT * FROM backup_requests WHERE site_id=? AND status='delivered' ORDER BY created_at,rowid", (site_id,))]

    @app.post("/api/agent/backup-requests/{request_id}/ack")
    def ack_request(request_id: UUID, body: FailedAck, site_id: Annotated[str, Depends(agent)]):
        with store.transaction() as db:
            row = db.execute("SELECT * FROM backup_requests WHERE id=? AND site_id=?", (str(request_id), site_id)).fetchone()
            if row is None:
                raise HTTPException(404, "Backup request not found")
            if row["status"] == "failed":
                return service.request_output(row)
            if row["status"] == "uploaded" or row["backup_id"]:
                raise HTTPException(409, "Request already uploading or uploaded")
            db.execute("UPDATE backup_requests SET status='failed',message=?,completed_at=? WHERE id=?", (clean_text(body.message or "Agent reported backup failure"), now(), str(request_id)))
            return service.request_output(db.execute("SELECT * FROM backup_requests WHERE id=?", (str(request_id),)).fetchone())

    @app.get("/api/sites/{site_id}/backups", dependencies=admin_deps)
    def history(site_id: UUID):
        with store.transaction() as db:
            service.site(db, str(site_id))
            return {"backups": [service.backup_output(db, r) for r in db.execute("SELECT * FROM backups WHERE site_id=? ORDER BY created_at DESC,rowid DESC LIMIT 50", (str(site_id),)).fetchall()],
                    "requests": [service.request_output(r) for r in db.execute("SELECT * FROM backup_requests WHERE site_id=? ORDER BY created_at DESC,rowid DESC LIMIT 50", (str(site_id),))]}

    @app.post("/api/agent/backups/upload", status_code=201)
    async def upload(request: Request, site_id: Annotated[str, Depends(agent)], filename: str,
                     request_id: UUID | None = None, source: Literal["scheduled", "on_demand", "direct"] = "direct"):
        filename = safe_filename(filename)
        if request.headers.get("content-type", "").split(";", 1)[0].strip().lower() != "application/octet-stream":
            raise HTTPException(415, "Use application/octet-stream with raw backup bytes")
        length = request.headers.get("content-length")
        expected = None
        if length is not None:
            if not re.fullmatch(r"[0-9]{1,20}", length):
                raise HTTPException(400, "Invalid Content-Length")
            expected = int(length)
            if expected > service.max_upload:
                raise HTTPException(413, "Backup exceeds per-file quota")
        if source == "on_demand" and request_id is None:
            raise HTTPException(422, "on_demand uploads require request_id")
        session = UploadSession(service, site_id, filename, request_id, source, expected)
        try:
            await service.persist(session.begin)
            async for chunk in upload_chunks(request):
                if chunk:
                    await service.persist(session.write, chunk)
            return await service.persist(session.finish)
        except OSError as exc:
            raise HTTPException(507 if exc.errno in (errno.ENOSPC, errno.EDQUOT) else 503, "Unable to persist backup staging file") from None
        finally:
            await service.persist(session.abort)

    @app.post("/api/sites/{site_id}/backups/{backup_id}/retry", dependencies=admin_deps)
    def retry(site_id: UUID, backup_id: UUID, body: Model):
        key = str(backup_id)
        with service.file_lock, store.transaction() as db:
            row = service.backup_row(db, str(site_id), key)
            if row["status"] in ("uploading", "queued", "transferring"):
                raise HTTPException(409, "Backup still active")
            if not row["local_available"] or not service.path(key).is_file():
                raise HTTPException(409, "Cached artifact unavailable; upload a new backup")
            failed = db.execute("SELECT * FROM backup_transfers WHERE backup_id=? AND status='failed'", (key,)).fetchall()
            if not failed:
                raise HTTPException(409, "No failed transfers to retry")
            service.check_queue_capacity(db, str(site_id))
            service.validate_targets(db, [{"id": r["destination_id"]} for r in failed])
            db.execute("UPDATE backup_transfers SET status='queued',attempts=0,error=NULL,completed_at=NULL,next_attempt=0 WHERE backup_id=? AND status='failed'", (key,))
            service.aggregate(db, key)
            result = service.backup_output(db, service.backup_row(db, str(site_id), key))
        service.wake.set()
        return result

    @app.delete("/api/sites/{site_id}/backups/{backup_id}/local", dependencies=admin_deps, status_code=204)
    def evict(site_id: UUID, backup_id: UUID):
        key = str(backup_id)
        with service.file_lock, store.transaction() as db:
            row = service.backup_row(db, str(site_id), key)
            if row["status"] in ("uploading", "queued", "transferring") or service.downloads.get(key):
                raise HTTPException(409, "Backup is active or being downloaded")
            service.path(key).unlink(missing_ok=True)
            db.execute("UPDATE backups SET local_available=0 WHERE id=?", (key,))
        return Response(status_code=204)

    @app.get("/api/sites/{site_id}/backups/{backup_id}/download", dependencies=admin_deps)
    def download(site_id: UUID, backup_id: UUID):
        key = str(backup_id)
        with service.file_lock, store.transaction() as db:
            row = service.backup_row(db, str(site_id), key)
            if not row["local_available"] or row["status"] == "uploading" or not service.path(key).is_file():
                raise HTTPException(404, "Complete cached backup unavailable")
            service.downloads[key] = service.downloads.get(key, 0) + 1

        def release():
            with service.file_lock:
                service.downloads[key] -= 1
                if not service.downloads[key]:
                    del service.downloads[key]

        # Release even if the peer disconnects or FileResponse raises.
        class LeasedFileResponse(FileResponse):
            async def __call__(self, scope, receive, send):
                try:
                    await super().__call__(scope, receive, send)
                finally:
                    release()

        return LeasedFileResponse(service.path(key), filename=row["filename"], media_type="application/octet-stream",
                                  headers={"X-Content-Type-Options": "nosniff"}, content_disposition_type="attachment")

    return service
