"""Runs the script as a child process and applies lifecycle commands.

* ``start``/``restart`` spawn the configured command in its own process group,
  with HUB_AGENT_SOCKET set so the SDK finds the agent. The hub token is never
  placed in the script's environment.
* ``stop`` sends SIGTERM to the group, waits ``stop_timeout``, then SIGKILL — the
  group is signalled while the leader is still known to be ours (no PID reuse).
* ``pause``/``resume``/``set_workers``/custom commands are forwarded to the
  script through the SDK socket; the script decides how to honour them.
* Crash restart: if the site wants to run and the script exits unexpectedly, it
  restarts with exponential backoff (5 s → 5 min). After 5 crashes in 10 minutes
  it stops retrying and reports an error until a human restarts it.
"""

from __future__ import annotations

import asyncio
import logging
import os
import shlex
import signal
import time
from collections import deque

import psutil

LOG = logging.getLogger("bambou-agent.process")
SAFE_ENV_DROP = ("HUB_AGENT_TOKEN", "HUB_TOKEN", "HUB_ADMIN_PASSWORD", "HUB_SECRET_KEY")


class Supervisor:
    def __init__(self, settings, report):
        self.settings = settings
        self.report = report                 # callable(level, message)
        self.process: asyncio.subprocess.Process | None = None
        self.desired = "stopped"
        self.restarts = 0
        self.crashes: deque = deque(maxlen=10)
        self.crash_loop = False
        self.started_at: float | None = None
        self.last_exit: int | None = None
        self._lock = asyncio.Lock()
        self._watch: asyncio.Task | None = None
        self.output_log = settings.state_dir / "script-output.log"

    @property
    def running(self) -> bool:
        return self.process is not None and self.process.returncode is None

    def snapshot(self) -> dict:
        info = {"state": "running" if self.running else "stopped", "desired": self.desired,
                "pid": self.process.pid if self.running else None, "restarts": self.restarts,
                "crash_loop": self.crash_loop, "last_exit": self.last_exit,
                "uptime": int(time.time() - self.started_at) if self.running and self.started_at else 0,
                "command": self.settings.command_display}
        if self.running:
            try:
                proc = psutil.Process(self.process.pid)
                children = proc.children(recursive=True)
                procs = [proc, *children]
                info["cpu_percent"] = round(sum(p.cpu_percent(None) for p in procs if p.is_running()), 1)
                info["memory_mb"] = round(sum(p.memory_info().rss for p in procs if p.is_running()) / 1024**2, 1)
                info["processes"] = len(procs)
            except psutil.Error:
                pass
        return info

    async def start(self, reason: str = "start") -> str:
        async with self._lock:
            if not self.settings.command:
                return "No --command configured; the agent only relays telemetry for an externally started script"
            if self.running:
                return "Already running"
            env = {k: v for k, v in os.environ.items() if k not in SAFE_ENV_DROP}
            env.update({"HUB_AGENT_SOCKET": str(self.settings.socket_path), "HUB_SITE_ID": self.settings.site_id or "",
                        "PYTHONUNBUFFERED": "1"})
            env.update(self.settings.extra_env)
            log = open(self.output_log, "ab", buffering=0)
            self._rotate_output()
            try:
                self.process = await asyncio.create_subprocess_exec(
                    *self.settings.command, cwd=str(self.settings.script_dir), env=env,
                    stdout=log, stderr=log, stdin=asyncio.subprocess.DEVNULL, start_new_session=True)
            finally:
                log.close()
            self.started_at = time.time()
            self.crash_loop = False
            LOG.info("Started script pid=%s (%s)", self.process.pid, reason)
            self._watch = asyncio.create_task(self._wait(self.process))
            return f"Started (pid {self.process.pid})"

    def _rotate_output(self):
        try:
            if self.output_log.exists() and self.output_log.stat().st_size > 50 * 1024**2:
                self.output_log.replace(self.output_log.with_suffix(".log.1"))
        except OSError:
            pass

    async def stop(self, reason: str = "stop") -> str:
        async with self._lock:
            process = self.process
            if process is None or process.returncode is not None:
                return "Not running"
            if self._watch:
                self._watch.cancel()
            pgid = os.getpgid(process.pid)
            os.killpg(pgid, signal.SIGTERM)
            try:
                await asyncio.wait_for(process.wait(), timeout=self.settings.stop_timeout)
            except asyncio.TimeoutError:
                LOG.warning("Script did not exit in %ss; killing", self.settings.stop_timeout)
                try:
                    os.killpg(pgid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                await process.wait()
            # Leftover children that ignored SIGTERM (e.g. browsers) — group still ours
            # because the leader was reaped just now and nothing reused the pgid yet.
            try:
                os.killpg(pgid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                pass
            self.last_exit = process.returncode
            LOG.info("Stopped script (%s), exit %s", reason, process.returncode)
            return f"Stopped (exit {process.returncode})"

    async def restart(self) -> str:
        await self.stop("restart")
        self.restarts += 1
        return await self.start("restart")

    async def _wait(self, process):
        code = await process.wait()
        self.last_exit = code
        if self.desired != "running" and self.desired != "paused":
            return
        now = time.time()
        self.crashes.append(now)
        recent = [t for t in self.crashes if now - t < 600]
        tail = self._tail()
        self.report("error", f"Script exited unexpectedly with code {code}" + (f"\n{tail}" if tail else ""))
        if not self.settings.crash_restart:
            return
        if len(recent) >= 5:
            self.crash_loop = True
            self.report("critical", "Script crashed 5 times in 10 minutes; automatic restarts paused. Use Restart after fixing it.")
            return
        delay = min(5 * 2 ** (len(recent) - 1), 300)
        LOG.warning("Restarting script in %ss", delay)
        await asyncio.sleep(delay)
        if self.desired in ("running", "paused") and not self.running:
            self.restarts += 1
            await self.start("crash restart")

    def _tail(self, lines: int = 15) -> str:
        try:
            with open(self.output_log, "rb") as stream:
                stream.seek(0, 2)
                size = stream.tell()
                stream.seek(max(0, size - 8192))
                text = stream.read().decode("utf-8", "replace")
            return "\n".join(text.splitlines()[-lines:])
        except OSError:
            return ""


def parse_command(value: str | None) -> list[str]:
    return shlex.split(value) if value else []
