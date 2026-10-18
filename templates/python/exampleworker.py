"""Harmless automation hooks. No target interaction or fabricated task counts."""
import json
import os
import signal
import socket
import threading


class AutomationHooks:
    def __init__(self):
        self.stop = threading.Event()
        descriptor = os.environ.get("HUB_WORKER_EVENTS_FD")
        self.events = socket.socket(fileno=int(descriptor)) if descriptor else None
        if self.events:
            self.events.setblocking(False)

    def report(self, event):
        if self.events:
            try:
                self.events.send(event)
            except OSError:
                # Telemetry is best effort, never a reason to repeat a real task.
                pass

    def task_completed(self):
        """Call only after a real unit of work has succeeded."""
        self.report(b"task_completed")

    def error(self):
        """Fixed sanitized report; never send exception text, keys or proxy URLs."""
        self.report(b"error")

    def reload_config(self):
        """Environment reflects the latest supervisor fetch at start/restart."""
        return {"ai_api_key": os.environ.get("AI_API_KEY", ""),
                "ai_preset_id": os.environ.get("AI_PRESET_ID", ""),
                "proxies": json.loads(os.environ.get("HUB_PROXIES_JSON", "[]"))}

    def process_next_task(self, config):
        """TODO: implement locally authorized business logic; return True on success.

        Use bounded network timeouts and self.stop for cancellation. Do not log
        config or secrets. The placeholder deliberately performs no work.
        """
        return False

    def run(self):
        config = self.reload_config()
        while not self.stop.is_set():
            try:
                if self.process_next_task(config):
                    self.task_completed()
            except Exception:
                self.error()
            self.stop.wait(1)


if __name__ == "__main__":
    worker = AutomationHooks()
    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, lambda *_: worker.stop.set())
    try:
        worker.run()
    finally:
        if worker.events:
            worker.events.close()
