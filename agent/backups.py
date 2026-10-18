"""Independent backup scheduler. Source paths are configured ONLY on the VPS."""
from datetime import datetime, timezone
import json
import logging
import math
import os
from pathlib import Path
import tarfile
import stat
import tempfile
import threading
import time

import requests

if __package__:
    from .local_files import LocalFiles
else:
    from local_files import LocalFiles

LOG = logging.getLogger("hub-agent.backups")


class BackupCancelled(Exception):
    pass


class BackupUploadUncertain(Exception):
    """The hub may have accepted the upload; never falsely acknowledge failure."""


class BackupHubError(RuntimeError):
    def __init__(self, status):
        self.status = status
        super().__init__(f"Backup hub returned HTTP {status}")


class LimitedWriter:
    def __init__(self, stream, limit, stop):
        self.stream, self.limit, self.stop = stream, limit, stop
        self.count = 0

    def write(self, data):
        if self.stop.is_set():
            raise BackupCancelled()
        if self.count + len(data) > self.limit:
            raise ValueError("Archive exceeds configured size limit")
        written = self.stream.write(data)
        self.count += written
        return written

    def tell(self):
        return self.count

    def flush(self):
        self.stream.flush()


class UploadReader:
    """Bounded file reads with cancellation, without loading an archive in RAM."""
    def __init__(self, stream, stop):
        self.stream, self.stop = stream, stop
        self.length = os.fstat(stream.fileno()).st_size

    def __len__(self):
        return self.length

    def tell(self):
        return self.stream.tell()

    def read(self, size=-1):
        if self.stop.is_set():
            raise BackupCancelled()
        return self.stream.read(min(size if size and size > 0 else 65536, 65536))


class BackupRunner:
    def __init__(self, hub, token, source, state_dir, stop_event, max_bytes=1073741824, runtime_dir=None):
        self.hub = hub.rstrip("/")
        self.source = Path(source).resolve() if source else None
        self.state_dir = Path(state_dir).resolve()
        self.runtime_dir = Path(runtime_dir).resolve() if runtime_dir else None
        self.local_files = LocalFiles(runtime_dir) if runtime_dir else None
        self.stop_event = stop_event
        self.max_bytes = max_bytes
        self.session = requests.Session()
        self.session.headers["Authorization"] = "Bearer " + token
        self.state_file = self.state_dir / "backup-state.json"
        self.scratch = self.state_dir / "backup-tmp"
        self.io_issue = False
        self.io_issue_reported = False
        try:
            self.state_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
            self.scratch.mkdir(parents=True, exist_ok=True, mode=0o700)
        except OSError:
            self.io_issue = True
            LOG.warning("Backup scratch storage unavailable; backups paused, worker supervision unaffected")
        self.last_uploaded = 0.0
        self.state_issue = False
        self.state_issue_reported = False
        self.pending_persist = False
        try:
            if self.state_file.exists():
                state = json.loads(self.state_file.read_text())
                timestamp = float(state["last_uploaded"])
                if not math.isfinite(timestamp) or timestamp < 0 or timestamp > time.time() + 300:
                    raise ValueError("Invalid backup checkpoint")
                self.last_uploaded = timestamp
        except (OSError, ValueError, TypeError, KeyError, OverflowError):
            self.state_issue = True
            LOG.warning("Backup checkpoint unreadable/invalid; periodic backups paused, worker supervision unaffected")
        self.retry_at = 0.0
        self.request_retry_at = {}
        self.thread = None

    def start(self):
        # Only our own generated temporary files; no source files are removed.
        try:
            for path in self.scratch.glob("backup-*.tar.gz"):
                if path.is_file() and not path.is_symlink():
                    path.unlink()
        except OSError:
            self.io_issue = True
            LOG.warning("Backup scratch cleanup unavailable; backups paused, worker supervision unaffected")
        self.thread = threading.Thread(target=self.run, name="site-backup", daemon=True)
        try:
            self.thread.start()
        except (OSError, RuntimeError):
            self.thread = None
            self.session.close()
            raise

    def close(self):
        if self.thread:
            self.thread.join(timeout=5)
            if self.thread.is_alive():
                LOG.warning("Backup thread still finishing network I/O; process exit may interrupt the upload")
        else:
            self.session.close()

    def api(self, method, path, **kwargs):
        response = self.session.request(method, self.hub + "/api/agent" + path,
                                        timeout=(5, 30), allow_redirects=False, **kwargs)
        try:
            if not 200 <= response.status_code < 300:
                raise BackupHubError(response.status_code)
            return response.json()
        finally:
            response.close()

    def configured(self):
        try:
            return bool(not self.io_issue and self.source and self.source.is_dir() and self.source.parent != self.source
                        and self.source != self.state_dir and self.state_dir not in self.source.parents)
        except OSError:
            return False

    def persist(self):
        temporary = self.state_file.with_suffix(".tmp")
        fd = os.open(temporary, os.O_CREAT | os.O_TRUNC | os.O_WRONLY, 0o600)
        with os.fdopen(fd, "w") as stream:
            json.dump({"last_uploaded": self.last_uploaded}, stream)
            stream.flush()
            os.fsync(stream.fileno())
        temporary.replace(self.state_file)

    @staticmethod
    def open_directory(path):
        """Anchor every path component with directory FDs and O_NOFOLLOW."""
        flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
        fd = os.open(os.sep, flags)
        try:
            for part in Path(path).parts[1:]:
                next_fd = os.open(part, flags, dir_fd=fd)
                os.close(fd)
                fd = next_fd
            return fd
        except BaseException:
            os.close(fd)
            raise

    @staticmethod
    def tar_info(name, metadata):
        info = tarfile.TarInfo(name)
        info.mode = stat.S_IMODE(metadata.st_mode)
        info.uid, info.gid = metadata.st_uid, metadata.st_gid
        info.mtime = metadata.st_mtime
        return info

    def pack(self, destination):
        if not self.configured():
            raise ValueError("Configure a source outside the supervisor state directory")
        state_metadata = self.state_dir.stat()
        state_identity = state_metadata.st_dev, state_metadata.st_ino
        excluded_paths = {self.state_dir}
        excluded_identities = {state_identity}
        if self.runtime_dir:
            excluded_paths.add(self.runtime_dir)
            if self.runtime_dir.exists():
                metadata = self.runtime_dir.stat()
                excluded_identities.add((metadata.st_dev, metadata.st_ino))

        def check():
            if self.stop_event.is_set():
                raise BackupCancelled()

        def unchanged(before, after):
            if (before.st_dev, before.st_ino) != (after.st_dev, after.st_ino):
                raise ValueError("Codebase changed during packaging")

        def add_directory(archive, fd, path, name):
            check()
            metadata = os.fstat(fd)
            info = self.tar_info(name, metadata)
            info.type = tarfile.DIRTYPE
            archive.addfile(info)
            for child in sorted(os.listdir(fd)):
                check()
                child_path = path / child
                before = os.stat(child, dir_fd=fd, follow_symlinks=False)
                if child_path in excluded_paths or (before.st_dev, before.st_ino) in excluded_identities:
                    continue
                child_name = name + "/" + child
                if stat.S_ISDIR(before.st_mode):
                    child_fd = os.open(child, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                    try:
                        unchanged(before, os.fstat(child_fd))
                        add_directory(archive, child_fd, child_path, child_name)
                    finally:
                        os.close(child_fd)
                elif stat.S_ISREG(before.st_mode):
                    child_fd = os.open(child, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
                    with os.fdopen(child_fd, "rb") as source:
                        metadata = os.fstat(source.fileno())
                        unchanged(before, metadata)
                        if not stat.S_ISREG(metadata.st_mode):
                            raise ValueError("Codebase file type changed during packaging")
                        info = self.tar_info(child_name, metadata)
                        info.size = metadata.st_size
                        archive.addfile(info, source)
                elif stat.S_ISLNK(before.st_mode):
                    target = os.readlink(child, dir_fd=fd)
                    unchanged(before, os.stat(child, dir_fd=fd, follow_symlinks=False))
                    info = self.tar_info(child_name, before)
                    info.type, info.linkname = tarfile.SYMTYPE, target
                    archive.addfile(info)
                elif stat.S_ISFIFO(before.st_mode):
                    info = self.tar_info(child_name, before)
                    info.type = tarfile.FIFOTYPE
                    archive.addfile(info)
                # Runtime sockets/devices are not ordinary codebase file data.

        root_fd = self.open_directory(self.source)
        try:
            output_fd = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
            with os.fdopen(output_fd, "wb") as stream:
                os.fchmod(stream.fileno(), 0o600)
                writer = LimitedWriter(stream, self.max_bytes, self.stop_event)
                with tarfile.open(fileobj=writer, mode="w|gz", dereference=False, compresslevel=6) as archive:
                    add_directory(archive, root_fd, self.source, self.source.name)
                writer.flush()
        finally:
            os.close(root_fd)

    def upload(self, path, source, request_id=None):
        timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        params = {"filename": f"codebase-{timestamp}.tar.gz", "source": source}
        if request_id:
            params["request_id"] = request_id
        with open(path, "rb") as stream:
            return self.api("POST", "/backups/upload", params=params,
                            headers={"Content-Type": "application/octet-stream"},
                            data=UploadReader(stream, self.stop_event))

    def perform(self, source, request_id=None):
        if not self.configured():
            raise ValueError("Local backup source is not configured")
        fd, filename = tempfile.mkstemp(prefix="backup-", suffix=".tar.gz", dir=self.scratch)
        os.close(fd)
        path = Path(filename)
        try:
            self.pack(path)
            try:
                result = self.upload(path, source, request_id)
            except requests.RequestException:
                raise BackupUploadUncertain() from None
            except BackupHubError as exc:
                if exc.status == 409 or exc.status >= 500:
                    raise BackupUploadUncertain() from None
                raise
            self.last_uploaded = time.time()
            self.pending_persist = True
            try:
                self.persist()
                self.pending_persist = False
                self.state_issue = False
                self.state_issue_reported = False
            except OSError:
                self.state_issue = True
                LOG.warning("Hub accepted backup but checkpoint could not be saved; periodic backups paused until persistence recovers")
            LOG.info("Backup uploaded to hub staging; cloud completion is tracked by the hub")
            return result
        finally:
            try:
                path.unlink(missing_ok=True)
            except OSError:
                self.io_issue = True
                LOG.warning("Temporary backup cleanup failed; preserving upload outcome and pausing future backups until storage is repaired")

    def tick(self, config):
        if self.local_files:
            # Explicit allowlist: never mirror credentials or future secret fields.
            safe = {key: config[key] for key in ("enabled", "interval_minutes", "destination_ids",
                    "agent_configured", "agent_last_seen", "next_backup_at") if key in config}
            self.local_files.atomic_write("backup-config.json", json.dumps(safe, indent=2) + "\n")
        if self.io_issue and not self.io_issue_reported:
            self.api("POST", "/errors", json={"level": "warning", "message":
                     "Agent backup scratch storage unavailable. Backups paused; repair agent state directory permissions/free space and restart. Worker supervision is unaffected."})
            self.io_issue_reported = True
        if self.pending_persist:
            try:
                self.persist()
                self.pending_persist = self.state_issue = self.state_issue_reported = False
            except OSError:
                pass
        if self.state_issue and not self.state_issue_reported:
            self.api("POST", "/errors", json={"level": "warning", "message":
                     "Backup schedule checkpoint invalid/unwritable. Periodic backups paused; fix agent backup-state.json or request a manual backup. Worker supervision is unaffected."})
            self.state_issue_reported = True
        now = time.time()
        interval = int(config["interval_minutes"]) * 60
        if not 15 * 60 <= interval <= 43200 * 60:
            raise ValueError("Invalid backup interval")
        due = max(self.last_uploaded + interval, self.retry_at)
        next_at = (datetime.fromtimestamp(max(now, due), timezone.utc).isoformat()
                   if self.configured() and config["enabled"] and not self.state_issue else None)
        self.api("POST", "/backup-status", json={"configured": self.configured(), "next_backup_at": next_at})
        requests_pending = self.api("GET", "/backup-requests")
        ids = {item["id"] for item in requests_pending}
        self.request_retry_at = {key: value for key, value in self.request_retry_at.items() if key in ids}
        handled_manual = False
        for request in requests_pending:
            if self.stop_event.is_set():
                return
            if now < self.request_retry_at.get(request["id"], 0):
                continue
            try:
                self.perform("on_demand", request["id"])
                handled_manual = True
            except BackupCancelled:
                raise
            except BackupUploadUncertain:
                self.request_retry_at[request["id"]] = time.time() + 300
                self.retry_at = time.time() + 300
                LOG.warning("Upload acceptance uncertain; keeping request pending and reconciling before retry")
            except Exception:
                message = ("Check --backup-dir and local agent state directory permissions/free space on this VPS" if not self.configured()
                           else "Backup packaging/upload failed; inspect local agent configuration and hub limits")
                self.api("POST", f"/backup-requests/{request['id']}/ack",
                         json={"status": "failed", "message": message})
                LOG.warning("On-demand backup failed; no archive contents were logged")
        if not handled_manual and not self.state_issue and self.configured() and config["enabled"] and now >= max(due, self.retry_at):
            try:
                self.perform("scheduled")
                self.retry_at = 0
            except BackupCancelled:
                raise
            except Exception:
                self.retry_at = time.time() + 300
                LOG.warning("Scheduled backup failed; retrying no earlier than five minutes")
                try:
                    self.api("POST", "/errors", json={"level": "warning", "message":
                             "Scheduled backup packaging/upload failed. Check the local source, archive size limit, hub staging quota and selected destinations; the agent will retry."})
                except (requests.RequestException, RuntimeError, ValueError):
                    pass

    def run(self):
        try:
            while not self.stop_event.is_set():
                try:
                    self.tick(self.api("GET", "/backup-config"))
                except BackupCancelled:
                    return
                except Exception:
                    # Keys, filenames, archive contents and upstream bodies are private.
                    LOG.warning("Backup hub unavailable or configuration rejected; retrying")
                self.stop_event.wait(5)
        finally:
            self.session.close()
