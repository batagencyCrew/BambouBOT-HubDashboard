"""Periodic background jobs in a single daemon thread (one hub process)."""

from __future__ import annotations

import logging
import threading
import time

LOG = logging.getLogger("hub.tasks")


class Tasks:
    def __init__(self, app):
        self.app = app
        self.stop_event = threading.Event()
        self.threads: list[threading.Thread] = []

    def every(self, seconds: float, name: str, func):
        def loop():
            while not self.stop_event.wait(seconds):
                try:
                    func()
                except Exception:
                    LOG.exception("Background task %s failed", name)
        thread = threading.Thread(target=loop, name=f"hub-{name}", daemon=True)
        thread.start()
        self.threads.append(thread)

    def stop(self):
        self.stop_event.set()
        for thread in self.threads:
            thread.join(timeout=10)


def start_tasks(app) -> Tasks:
    from . import alerts
    tasks = Tasks(app)
    db = app.state.db
    alerts.ensure_default_rules(db)
    app.state.backups.recover_on_start()
    tasks.every(20, "alerts", lambda: alerts.evaluate(app))
    tasks.every(5, "backup-transfers", lambda: app.state.backups.run_due())
    tasks.every(600, "backup-housekeeping", app.state.backups.housekeeping)
    tasks.every(3600, "partitions", lambda: db.ensure_partitions(2))
    tasks.every(3600, "sessions", lambda: db.execute("DELETE FROM sessions WHERE expires_at < now() - interval '7 days'"))
    tasks.every(300, "commands", lambda: db.execute(
        "UPDATE commands SET status='failed', completed_at=now(), result='Expired before the agent acknowledged it' "
        "WHERE status IN ('pending','delivered') AND expires_at < now()"))
    return tasks
