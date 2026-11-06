"""Bambou Hub SDK for Python automation scripts.

    from bambouhub import hub, worker

    hub.configure(site="alpha")            # optional; the agent knows the site
    w = worker("worker-3")                    # declare a worker (thread/task/process/browser)
    w.status("idle", reason="queue empty")
    w.log.info("connected")
    hub.metric("links_sent", 1, worker=w)
    with hub.cost("2captcha", "captcha") as c:   # adds 1 event; c.amount = price
        ...solve captcha...
    hub.balance("2captcha", 12.40, low=5)
    hub.proxy("proxy-1", "ok", key="a1b2c3")
    hub.issue("Worker stuck", "no progress for 10 min", severity="warning")
    hub.on_command("refresh_cookies", handler)   # custom command from dashboard/bot

Everything is buffered locally and flushed by a background thread to the agent
over a unix socket. Nothing in the script ever talks to the hub directly, and the
script never holds the hub token.
"""

from .client import Cost, Hub, worker

__all__ = ["hub", "worker", "Cost", "Hub"]
__version__ = "2.0.0"

hub = Hub()
