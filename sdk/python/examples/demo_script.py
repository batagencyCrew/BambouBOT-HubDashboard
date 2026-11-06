"""Example automation script using the bambouhub SDK with a thread pool.

Run under the agent:  bambou-agent --command "python3 demo_script.py" --file config.json
Shows: workers, logging integration, metrics, costs (addCost), balances,
proxies, issues, pause/resume, live worker-count changes and a custom command.
"""

import json
import logging
import random
import threading
import time
from pathlib import Path

from bambouhub import hub

log = logging.getLogger("demo")
CONFIG = Path(__file__).with_name("config.json")


def load_config() -> dict:
    try:
        return json.loads(CONFIG.read_text())
    except (OSError, ValueError):
        return {}


config = load_config()
hub.install_logging(logging.INFO)          # existing logging calls now reach the hub
hub.set_price("demo-captcha", 0.0008, unit="solve")


@hub.on_command("say_hello", description="Log a greeting from every worker")
def say_hello():
    for w in hub.workers.values():
        w.log.info("hello from the dashboard")
    return f"greeted {len(hub.workers)} workers"


@hub.on_config_change
def reload(path: str):
    global config
    config = load_config()
    log.info("Config reloaded from %s: %s workers", path, config.get("workers"))


def work(name: str, stop: threading.Event):
    with hub.worker(name) as w:
        while not stop.is_set() and not hub.stopping.is_set():
            hub.wait_if_paused()
            if random.random() < 0.2:
                w.idle("waiting for a chat partner")
                time.sleep(0.5)
                continue
            w.running()
            hub.add_cost(provider="demo-captcha", category="captcha")     # price from set_price
            hub.add_cost(0.0002, provider="openai", category="ai", unit="request")
            hub.count("links_sent", 1)
            hub.proxy("proxy-1", "ok", url="http://user:secret@10.0.0.1:8080")
            w.task_done()
            log.info("chat finished")
            time.sleep(0.3)


def main():
    threads: dict[str, tuple[threading.Thread, threading.Event]] = {}
    hub.balance("demo-captcha", 4.2, low=5)
    while not hub.stopping.is_set():
        wanted = hub.desired_workers if hub.desired_workers is not None else int(config.get("workers", 2))
        while len(threads) < wanted:
            name = f"worker-{len(threads) + 1}"
            stop = threading.Event()
            thread = threading.Thread(target=work, args=(name, stop), daemon=True)
            threads[name] = (thread, stop)
            thread.start()
        while len(threads) > wanted:
            name = sorted(threads)[-1]
            threads.pop(name)[1].set()
            hub.remove_worker(name)
        time.sleep(1)
    for _, stop in threads.values():
        stop.set()
    hub.close()


if __name__ == "__main__":
    import signal
    signal.signal(signal.SIGTERM, lambda *_: hub.stopping.set())
    main()
