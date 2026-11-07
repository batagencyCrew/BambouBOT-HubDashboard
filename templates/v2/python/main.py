"""<SITE NAME> automation — Bambou hub starter (Python).

Copy this folder, then replace every block marked ``TODO``. Everything else
(workers, logs, costs, proxy health, issues, pause/resume, live worker count,
config reload, graceful stop) is already wired to the hub.

Run under the agent (recommended):

    bambou-agent --script-dir . --command "python3 main.py" \
        --file config.json --file .env --file proxies.txt

Run alone for local testing (the SDK silently drops telemetry without an agent):

    python3 main.py
"""

from __future__ import annotations

import json
import logging
import os
import random
import signal
import sys
import threading
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
# If the SDK is not pip-installed, point at a copy of sdk/python (or set PYTHONPATH).
sys.path.insert(0, os.environ.get("BAMBOUHUB_SDK", str(HERE / "vendor")))

from bambouhub import hub  # noqa: E402

log = logging.getLogger("script")

# ---------------------------------------------------------------------------
# Configuration (config.json, .env, proxies.txt are editable from the hub)
# ---------------------------------------------------------------------------

CONFIG_FILE = HERE / "config.json"
ENV_FILE = HERE / ".env"
PROXIES_FILE = HERE / "proxies.txt"


def read_env(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if not path.exists():
        return values
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.removeprefix("export ").partition("=")
        values[key.strip()] = value.strip().strip('"').strip("'")
    return values


def read_proxies(path: Path) -> list[str]:
    if not path.exists():
        return []
    return [line.split("#", 1)[0].strip() for line in path.read_text().splitlines()
            if line.split("#", 1)[0].strip()]


class Settings:
    """Reloaded whenever the hub rewrites one of the files."""

    def __init__(self):
        self.lock = threading.Lock()
        self.reload()

    def reload(self):
        config = json.loads(CONFIG_FILE.read_text()) if CONFIG_FILE.exists() else {}
        env = read_env(ENV_FILE)
        with self.lock:
            self.config = config
            self.env = env
            self.proxies = read_proxies(PROXIES_FILE)
            self.workers = int(config.get("workers", 2))
            self.task_delay = float(config.get("task_delay_seconds", 2))
            # TODO: read the settings your script needs, e.g.
            # self.target_url = config["target_url"]
            # self.api_key = env.get("AI_API_KEY", "")


settings = Settings()

# ---------------------------------------------------------------------------
# Prices: declare once, then hub.add_cost(provider=...) anywhere uses them
# ---------------------------------------------------------------------------

# TODO: set your real unit prices (or pass an exact amount to add_cost each time).
hub.set_price("captcha-provider", 0.0008, unit="solve")
hub.set_price("ai-provider", 0.0004, unit="request")

# ---------------------------------------------------------------------------
# Your automation
# ---------------------------------------------------------------------------


class TaskFailed(Exception):
    """Raise for an expected failure of one task (the worker keeps going)."""


def pick_proxy(worker_index: int) -> str | None:
    proxies = settings.proxies
    return proxies[worker_index % len(proxies)] if proxies else None


def open_session(worker_name: str, proxy: str | None):
    """TODO: create your browser/page/HTTP session for one worker.

    Return whatever object your do_task needs (Selenium driver, Playwright page,
    requests.Session, ...). Return None if not needed.
    """
    return None


def close_session(session) -> None:
    """TODO: close the browser/session created by open_session."""


def do_task(worker, session, proxy: str | None) -> dict:
    """TODO: one unit of work (one chat, one signup, one post, ...).

    Replace the simulation below with real code. Report costs where money is
    spent and proxy results where you learn them. Return a small dict that
    describes the result (counted as metrics below).
    """
    # --- simulation: delete from here ---------------------------------------
    time.sleep(random.uniform(0.5, 1.5))
    if random.random() < 0.05:
        if proxy:
            hub.proxy(f"proxy-{settings.proxies.index(proxy) + 1}", "blocked", url=proxy, detail="HTTP 403 (simulated)")
        raise TaskFailed("target page refused the request (simulated)")
    hub.add_cost(provider="captcha-provider", category="captcha")           # priced by set_price
    hub.add_cost(provider="ai-provider", category="ai", quantity=3)        # 3 requests
    if proxy:
        hub.proxy(f"proxy-{settings.proxies.index(proxy) + 1}", "ok", url=proxy)
    return {"links_sent": random.randint(0, 2), "messages": random.randint(3, 12)}
    # --- simulation: delete to here -----------------------------------------


# ---------------------------------------------------------------------------
# Worker loop (normally no changes needed)
# ---------------------------------------------------------------------------

def worker_loop(index: int, stop: threading.Event):
    name = f"worker-{index + 1}"
    proxy = pick_proxy(index)
    failures = 0
    with hub.worker(name) as w:
        session = None
        try:
            session = open_session(name, proxy)
            while not stop.is_set() and not hub.stopping.is_set():
                if hub.paused.is_set():
                    w.idle("paused from the hub")
                    hub.wait_if_paused()
                    continue
                w.running()
                started = time.monotonic()
                try:
                    result = do_task(w, session, proxy)
                except TaskFailed as exc:
                    failures += 1
                    w.log.warning(f"Task failed: {exc}")
                    hub.count("tasks_failed")
                    if failures >= 5:
                        hub.issue(f"{name} keeps failing", f"{failures} failures in a row; last: {exc}",
                                  severity="warning", key=f"failing:{name}")
                        w.error(f"{failures} failures in a row")
                        time.sleep(30)
                    continue
                failures = 0
                w.task_done()
                hub.count("tasks_completed")
                hub.timing("task_seconds", time.monotonic() - started)
                for metric, value in result.items():
                    hub.count(metric, value)
                log.info("Task finished: %s", result)
                stop.wait(settings.task_delay)
        except Exception:
            log.exception("%s crashed", name)
            hub.issue(f"{name} crashed", "See the worker's logs for the traceback.", severity="critical",
                      key=f"crash:{name}")
            raise
        finally:
            close_session(session)


# ---------------------------------------------------------------------------
# Hub commands (shown as buttons in the dashboard and as bot commands)
# ---------------------------------------------------------------------------

@hub.on_command("refresh_sessions", description="Close and reopen every worker's session")
def refresh_sessions():
    # TODO: implement (e.g. set a flag each worker checks), or delete this command.
    return "Not implemented in this script yet"


@hub.on_config_change
def on_config_change(path: str):
    settings.reload()
    log.info("Reloaded settings after hub edit of %s (workers=%s)", path, settings.workers)


# ---------------------------------------------------------------------------
# Main: keeps the number of workers equal to config / hub "Set workers"
# ---------------------------------------------------------------------------

def main():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    hub.install_logging(logging.INFO)
    signal.signal(signal.SIGTERM, lambda *_: hub.stopping.set())
    signal.signal(signal.SIGINT, lambda *_: hub.stopping.set())
    log.info("Starting with %s workers and %s proxies", settings.workers, len(settings.proxies))

    # TODO: report provider balances if you can query them, e.g. every 10 minutes:
    # hub.balance("captcha-provider", captcha_client.balance(), low=5)

    running: dict[int, tuple[threading.Thread, threading.Event]] = {}
    while not hub.stopping.is_set():
        wanted = hub.desired_workers if hub.desired_workers is not None else settings.workers
        for index in range(len(running), wanted):
            stop = threading.Event()
            thread = threading.Thread(target=worker_loop, args=(index, stop), name=f"worker-{index + 1}", daemon=True)
            running[index] = (thread, stop)
            thread.start()
        for index in sorted(running, reverse=True):
            if index < wanted:
                break
            running.pop(index)[1].set()
            hub.remove_worker(f"worker-{index + 1}")
        time.sleep(1)

    log.info("Stopping workers")
    for _, stop in running.values():
        stop.set()
    for thread, _ in running.values():
        thread.join(timeout=15)
    hub.close()


if __name__ == "__main__":
    main()
