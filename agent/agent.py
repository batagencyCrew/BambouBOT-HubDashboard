#!/usr/bin/env python3
"""Site-scoped supervisor. Only runs a command configured locally by the operator."""
import argparse
import json
import logging
import os
from pathlib import Path
import shlex
import signal
import socket
import subprocess
import threading
import time
from urllib.parse import urlparse
from uuid import NAMESPACE_URL, UUID, uuid5

import psutil
import requests

if __package__:
    from .backups import BackupRunner
    from .local_files import HubError, LocalFiles
    from .statistics_reporting import report_statistics
else:
    from backups import BackupRunner
    from local_files import HubError, LocalFiles
    from statistics_reporting import report_statistics

LOG = logging.getLogger("hub-agent")


class Agent:
    def __init__(self, hub, token, command, state_dir, backup_dir=None, backup_max_bytes=1073741824,
                 runtime_dir="./runtime"):
        self.hub = hub.rstrip("/")
        self.worker_namespace = uuid5(NAMESPACE_URL, self.hub)
        self.command = command
        self.session = requests.Session()
        self.session.headers["Authorization"] = "Bearer " + token
        self.stop_event = threading.Event()
        self.workers = {}
        self.reported_exits = set()
        self.worker_events = {}
        self.tasks_completed = {}
        self.pending_worker_errors = set()
        self.config = None
        self.running = False
        self.state_dir = Path(state_dir)
        self.state_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.state_file = self.state_dir / "completed.json"
        # Fail closed on corrupt state rather than repeating lifecycle actions.
        self.completed = json.loads(self.state_file.read_text()) if self.state_file.exists() else {}
        self.local_files = LocalFiles(runtime_dir)
        self.backup_runner = BackupRunner(self.hub, token, backup_dir, self.state_dir,
                                          self.stop_event, backup_max_bytes, runtime_dir=runtime_dir)

    def request(self, method, path, **kwargs):
        response = self.session.request(method, self.hub + "/api/agent" + path,
                                        timeout=(5, 20), allow_redirects=False, **kwargs)
        try:
            if not 200 <= response.status_code < 300:
                # Never print response bodies: config responses can contain secrets.
                raise HubError(response.status_code)
            return response.json()
        finally:
            response.close()

    def report_statistics(self, links_sent_successfully, average_messages_per_chat):
        """Opt-in absolute whole-site snapshot, never derived from worker events."""
        return report_statistics(self.request, links_sent_successfully, average_messages_per_chat)

    def fetch_config(self):
        return self.local_files.fetch(self.request)

    def persist(self):
        tmp = self.state_file.with_suffix(".tmp")
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as handle:
            json.dump(self.completed, handle)
            handle.flush()
            os.fsync(handle.fileno())
        tmp.replace(self.state_file)

    def spawn(self, worker_id):
        env = os.environ.copy()
        # Do not expose the supervisor's authentication token to worker processes.
        for secret in ("HUB_AGENT_TOKEN", "HUB_ADMIN_PASSWORD", "HUB_ENCRYPTION_KEY", "HUB_SIGNING_KEY", "CAPTCHA_API_KEY"):
            env.pop(secret, None)
        env.update({
            "HUB_WORKER_ID": self.telemetry_id(worker_id),
            "AI_API_KEY": self.config.get("ai_api_key") or "",
            "AI_PRESET_ID": self.config.get("ai_preset_id") or "",
            "HUB_PROXIES_JSON": json.dumps(self.config.get("proxies", [])),
        })
        parent, child = socket.socketpair(socket.AF_UNIX, socket.SOCK_DGRAM)
        parent.setblocking(False)
        env["HUB_WORKER_EVENTS_FD"] = str(child.fileno())
        try:
            process = subprocess.Popen(self.command, env=env, start_new_session=True,
                                       pass_fds=(child.fileno(),),
                                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except BaseException:
            parent.close()
            raise
        finally:
            child.close()
        self.worker_events[worker_id] = parent
        metrics = psutil.Process(process.pid)
        metrics.cpu_percent()
        self.workers[worker_id] = (process, metrics)
        self.reported_exits.discard(worker_id)

    def telemetry_id(self, worker_id):
        return str(uuid5(self.worker_namespace, worker_id))

    def stop_worker(self, worker_id):
        self.stop_selected([worker_id])

    def stop_selected(self, worker_ids):
        self.collect_worker_events()
        processes = [self.workers.pop(worker_id)[0] for worker_id in worker_ids]
        for worker_id in worker_ids:
            channel = self.worker_events.pop(worker_id, None)
            if channel:
                channel.close()
        # Signal all groups first; one shared grace period avoids N × 10s stalls.
        for process in processes:
            try:
                os.killpg(process.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
        deadline = time.monotonic() + 10
        for process in processes:
            try:
                process.wait(timeout=max(0, deadline - time.monotonic()))
            except subprocess.TimeoutExpired:
                pass
        for process in processes:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.wait()

    def stop_workers(self):
        self.running = False
        self.stop_selected(list(self.workers))

    def reconcile(self):
        count = int(self.config["number_of_workers"]) if self.running else 0
        if not 0 <= count <= 100:
            raise ValueError("Worker count outside supported range")
        desired = {f"worker-{i + 1}" for i in range(count)}
        self.stop_selected([worker_id for worker_id in self.workers if worker_id not in desired])
        for worker_id in sorted(desired - self.workers.keys()):
            self.spawn(worker_id)
        # Failed workers remain visible; restart is explicit to avoid crash loops.

    def collect_worker_events(self):
        for worker_id, channel in self.worker_events.items():
            # Bounded work; messages cannot carry arbitrary log text/secrets.
            for _ in range(1000):
                try:
                    event = channel.recv(256)
                except BlockingIOError:
                    break
                if event == b"task_completed":
                    self.tasks_completed[worker_id] = self.tasks_completed.get(worker_id, 0) + 1
                elif event == b"error":
                    self.pending_worker_errors.add(worker_id)

    def heartbeat(self):
        self.collect_worker_events()
        workers = []
        for worker_id, (process, metrics) in self.workers.items():
            alive = process.poll() is None
            cpu, memory = 0, 0
            if alive:
                try:
                    cpu = metrics.cpu_percent()
                    memory = metrics.memory_info().rss / (1024 * 1024)
                except psutil.Error:
                    pass
            workers.append(dict(id=self.telemetry_id(worker_id), name=worker_id,
                                status="running" if alive else "error",
                                cpu_percent=cpu, memory_mb=memory,
                                tasks_completed=self.tasks_completed.get(worker_id, 0)))
        result = self.request("POST", "/heartbeat", json={
            "status": "degraded" if any(w["status"] == "error" for w in workers) else "healthy",
            "workers": workers,
        })
        if result.get("site_id"):
            self.worker_namespace = UUID(result["site_id"])
        for worker_id in list(self.pending_worker_errors):
            self.request("POST", "/errors", json={
                "worker_id": self.telemetry_id(worker_id), "level": "error",
                "message": "Worker automation hook failed; inspect local implementation"})
            self.pending_worker_errors.discard(worker_id)
        for worker_id, (process, _) in self.workers.items():
            if process.poll() is not None and worker_id not in self.reported_exits:
                exit_code = process.returncode
                self.request("POST", "/errors", json={
                    "worker_id": self.telemetry_id(worker_id), "level": "error",
                    "message": f"Worker process exited with code {exit_code}; explicit restart required",
                })
                self.reported_exits.add(worker_id)
        return result["desired_state"]

    def commands(self):
        for command in self.request("GET", "/commands"):
            command_id = command["id"]
            if command_id not in self.completed:
                try:
                    if command["action"] not in ("start", "stop", "restart"):
                        raise ValueError("Unsupported lifecycle action")
                    if command["action"] in ("start", "restart"):
                        # A restart must use the latest saved secrets and proxy pool.
                        self.config = self.fetch_config()
                    if command["action"] in ("stop", "restart"):
                        self.stop_workers()
                    if command["action"] in ("start", "restart"):
                        self.running = True
                    self.reconcile()
                    result = {"status": "completed", "message": "Local lifecycle action applied"}
                except Exception:
                    LOG.warning("Local lifecycle action failed; details suppressed to protect secrets")
                    result = {"status": "failed", "message": "Local lifecycle action failed; inspect agent service logs"}
                self.completed[command_id] = result
                self.persist()
            self.request("POST", f"/commands/{command_id}/ack", json=self.completed[command_id])

    def run(self):
        config_at = heartbeat_at = 0
        initialized = False
        try:
            try:
                self.backup_runner.start()
            except (OSError, RuntimeError):
                LOG.warning("Backup scheduler could not start; worker supervision will continue")
            while not self.stop_event.is_set():
                try:
                    now = time.monotonic()
                    if now >= config_at:
                        self.config = self.fetch_config()
                        config_at = now + 30
                    if now >= heartbeat_at:
                        desired_state = self.heartbeat()
                        if not initialized:
                            # Recover desired state after a supervisor restart.
                            self.running = desired_state == "running"
                            initialized = True
                        heartbeat_at = now + 15
                    self.commands()
                    self.reconcile()
                except (requests.RequestException, RuntimeError, ValueError, OSError):
                    LOG.warning("Hub unavailable or request rejected; retrying in 5 seconds")
                self.stop_event.wait(5)
        finally:
            self.stop_event.set()
            self.stop_workers()
            self.backup_runner.close()
            self.session.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--hub", default=os.environ.get("HUB_URL"))
    parser.add_argument("--command", required=True, help="Local worker command, parsed without a shell")
    parser.add_argument("--state-dir", default="./agent-state")
    parser.add_argument("--runtime-dir", default=os.environ.get("HUB_RUNTIME_DIR", "./runtime"))
    parser.add_argument("--backup-dir", default=os.environ.get("HUB_BACKUP_DIR"),
                        help="Local codebase directory to archive; never configured by the hub")
    parser.add_argument("--backup-max-bytes", type=int, default=1073741824,
                        help="Maximum compressed archive bytes (default 1 GiB)")
    args = parser.parse_args()
    token = os.environ.get("HUB_AGENT_TOKEN")
    if not args.hub or not token:
        parser.error("Set HUB_URL and HUB_AGENT_TOKEN")
    url = urlparse(args.hub)
    if not url.hostname or url.username or url.password or url.query or url.fragment or url.path not in ("", "/"):
        parser.error("Hub must be an origin URL without credentials, query, or path")
    if url.scheme != "https" and not (url.scheme == "http" and url.hostname in ("localhost", "127.0.0.1", "::1")):
        parser.error("Public hub connections require HTTPS")
    command = shlex.split(args.command)
    if not command:
        parser.error("Worker command cannot be empty")
    if args.backup_max_bytes < 1:
        parser.error("Backup size limit must be positive")
    if args.backup_dir and not Path(args.backup_dir).is_dir():
        parser.error("Backup source must be an existing local directory")
    if args.backup_dir:
        source, state = Path(args.backup_dir).resolve(), Path(args.state_dir).resolve()
        if source.parent == source or source == state or state in source.parents:
            parser.error("Backup source must be outside the supervisor state directory and cannot be filesystem root")
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    agent = Agent(args.hub, token, command, args.state_dir, args.backup_dir, args.backup_max_bytes,
                  runtime_dir=args.runtime_dir)
    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, lambda *_: agent.stop_event.set())
    agent.run()


if __name__ == "__main__":
    main()
