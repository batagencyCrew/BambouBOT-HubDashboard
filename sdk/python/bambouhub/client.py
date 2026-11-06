"""SDK implementation. Standard library only (Python 3.9+)."""

from __future__ import annotations

import atexit
import contextvars
import json
import logging
import os
import socket
import threading
import time
import traceback
import uuid
from collections import deque
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable

SDK = "python/2.0.0"
NAMESPACE = uuid.UUID("7d6f2a62-8f3c-4d8e-9a43-3b9c1e0b5a10")
LEVELS = {"debug", "info", "notice", "warning", "error", "critical"}
_current_worker: contextvars.ContextVar["Worker | None"] = contextvars.ContextVar("bambouhub_worker", default=None)
_LOG = logging.getLogger("bambouhub")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


# ---------------------------------------------------------------------------
# Workers
# ---------------------------------------------------------------------------

class Worker:
    """One unit of parallel work: a thread, asyncio task, process or browser."""

    def __init__(self, hub: "Hub", name: str):
        self.hub = hub
        self.name = name
        self.id = str(uuid.uuid5(NAMESPACE, f"{hub.site_key}:{name}"))
        self._status = "starting"
        self.detail: dict = {}
        self.tasks_completed = 0
        self.started_at = time.time()
        self.log = _WorkerLog(self)

    # state ---------------------------------------------------------------
    def status(self, status: str, reason: str | None = None, **detail):
        """running | idle | error | stopped | starting. ``reason`` shows in alerts."""
        if status not in ("starting", "running", "idle", "error", "stopped"):
            raise ValueError("status must be starting, running, idle, error or stopped")
        self._status = status
        self.detail = {**detail, **({"reason": reason} if reason else {})}
        self.hub._presence_dirty.set()

    def running(self, **detail):
        self.status("running", **detail)

    def idle(self, reason: str | None = None, **detail):
        self.status("idle", reason, **detail)

    def error(self, reason: str | None = None, **detail):
        self.status("error", reason, **detail)

    def stopped(self):
        self.status("stopped")

    def task_done(self, count: int = 1):
        self.tasks_completed += count

    # attribution ---------------------------------------------------------
    def bind(self):
        """Attribute logs from the current thread/asyncio task to this worker."""
        _current_worker.set(self)
        return self

    def __enter__(self):
        self._token = _current_worker.set(self)
        if self._status == "starting":
            self.running()
        return self

    def __exit__(self, exc_type, exc, tb):
        if exc is not None:
            self.log.error(f"Worker crashed: {exc}", exc_info=(exc_type, exc, tb))
            self.error(str(exc)[:200])
        else:
            self.stopped()
        _current_worker.reset(self._token)
        return False

    def snapshot(self) -> dict:
        return {"id": self.id, "name": self.name, "status": self._status, "detail": self.detail,
                "tasks_completed": self.tasks_completed, "pid": os.getpid()}


class _WorkerLog:
    def __init__(self, worker: Worker):
        self.worker = worker

    def _emit(self, level, message, **kw):
        self.worker.hub.log(level, message, worker=self.worker, **kw)

    def debug(self, message, **kw):
        self._emit("debug", message, **kw)

    def info(self, message, **kw):
        self._emit("info", message, **kw)

    def warning(self, message, **kw):
        self._emit("warning", message, **kw)

    def error(self, message, **kw):
        self._emit("error", message, **kw)

    def critical(self, message, **kw):
        self._emit("critical", message, **kw)

    warn = warning


def worker(name: str) -> Worker:
    from . import hub
    return hub.worker(name)


# ---------------------------------------------------------------------------
# Costs
# ---------------------------------------------------------------------------

@dataclass
class Cost:
    """Context manager for a single priced operation.

        with hub.cost("capsolver", "captcha") as c:
            token = solve()
            c.amount = 0.0008          # or rely on hub.set_price(...)
        # failed operations can be skipped: c.cancel()
    """

    hub: "Hub"
    provider: str
    category: str
    quantity: float = 1
    unit: str | None = None
    amount: float | None = None
    meta: dict = field(default_factory=dict)
    cancelled: bool = False

    def cancel(self):
        self.cancelled = True

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        if not self.cancelled:
            self.hub.add_cost(self.amount, provider=self.provider, category=self.category, quantity=self.quantity,
                              unit=self.unit, meta={**self.meta, **({"failed": True} if exc else {})})
        return False


class _CostLedger:
    """Accumulates cost entries locally; flushed as aggregates or individually."""

    def __init__(self):
        self.lock = threading.Lock()
        self.pending: dict[tuple, dict] = {}
        self.individual: list[dict] = []
        self.prices: dict[str, tuple[float, str, str | None]] = {}
        self.totals: dict[tuple[str, str], float] = {}   # (provider, currency) -> running total since start

    def price(self, provider: str, amount: float, currency: str, unit: str | None):
        self.prices[provider] = (float(amount), currency.upper(), unit)

    def add(self, amount, provider, category, quantity, unit, currency, worker_id, meta, breakdown):
        if amount is None:
            if provider not in self.prices:
                raise ValueError(f"No amount given and no price set for {provider!r}; call hub.set_price() first")
            unit_price, currency, default_unit = self.prices[provider]
            amount = unit_price * quantity
            unit = unit or default_unit
        amount = float(amount)
        if amount < 0 or amount != amount:
            raise ValueError("Cost amount must be a non-negative number")
        currency = (currency or "USD").upper()[:3]
        with self.lock:
            self.totals[(provider, currency)] = self.totals.get((provider, currency), 0.0) + amount
            if breakdown or meta:
                self.individual.append({"event_id": str(uuid.uuid4()), "ts": _now(), "provider": provider,
                                        "category": category, "amount": round(amount, 6), "currency": currency,
                                        "quantity": quantity, "unit": unit, "worker_id": worker_id, "meta": meta or {}})
                return
            key = (provider, category, currency, unit, worker_id)
            entry = self.pending.setdefault(key, {"amount": 0.0, "quantity": 0.0, "count": 0})
            entry["amount"] += amount
            entry["quantity"] += quantity
            entry["count"] += 1

    def drain(self) -> list[dict]:
        with self.lock:
            out = self.individual
            self.individual = []
            for (provider, category, currency, unit, worker_id), entry in self.pending.items():
                out.append({"event_id": str(uuid.uuid4()), "ts": _now(), "provider": provider, "category": category,
                            "amount": round(entry["amount"], 6), "currency": currency, "quantity": entry["quantity"],
                            "unit": unit, "worker_id": worker_id, "meta": {"aggregated": entry["count"]}})
            self.pending = {}
        return out

    def summary(self) -> dict:
        with self.lock:
            result: dict[str, dict[str, float]] = {}
            for (provider, currency), total in self.totals.items():
                result.setdefault(currency, {})[provider] = round(total, 6)
            return result


# ---------------------------------------------------------------------------
# Hub client
# ---------------------------------------------------------------------------

class Hub:
    """Process-wide SDK entry point (``from bambouhub import hub``)."""

    def __init__(self):
        self._lock = threading.RLock()
        self._started = False
        self.site_key = os.environ.get("HUB_SITE_ID") or os.environ.get("HUB_SITE", "local")
        self.workers: dict[str, Worker] = {}
        self._logs: deque = deque(maxlen=20000)
        self._metrics: deque = deque(maxlen=20000)
        self._balances: dict[tuple, dict] = {}
        self._proxies: deque = deque(maxlen=5000)
        self._issues: deque = deque(maxlen=500)
        self._acks: deque = deque(maxlen=500)
        self._costs = _CostLedger()
        self._handlers: dict[str, tuple[Callable, str, dict]] = {}
        self._config_callbacks: list[Callable[[str], Any]] = []
        self._presence_dirty = threading.Event()
        self._stop = threading.Event()
        self._wake = threading.Event()
        self.paused = threading.Event()        # set while paused from the dashboard
        self.stopping = threading.Event()      # set when a graceful stop was requested
        self.desired_workers: int | None = None
        self.flush_interval = 2.0
        self.transport: _Transport | None = None
        self.dropped = 0

    # setup ---------------------------------------------------------------
    def configure(self, *, socket_path: str | None = None, hub_url: str | None = None, token: str | None = None,
                  flush_interval: float | None = None, site: str | None = None):
        """Optional. Defaults come from the environment the agent sets."""
        with self._lock:
            if site:
                self.site_key = site
            if flush_interval:
                self.flush_interval = max(0.5, float(flush_interval))
            socket_path = socket_path or os.environ.get("HUB_AGENT_SOCKET")
            hub_url = hub_url or os.environ.get("HUB_URL")
            token = token or os.environ.get("HUB_AGENT_TOKEN")
            if socket_path:
                self.transport = _SocketTransport(self, socket_path)
            elif hub_url and token:
                self.transport = _HttpTransport(self, hub_url, token)
            else:
                self.transport = _NullTransport()
            self._start()
        return self

    def _ensure(self):
        if not self._started:
            self.configure()

    def _start(self):
        if self._started:
            return
        self._started = True
        threading.Thread(target=self._flusher, name="bambouhub-flush", daemon=True).start()
        atexit.register(self.close)

    def close(self, timeout: float = 5.0):
        if not self._started or self._stop.is_set():
            return
        for w in self.workers.values():
            if w._status not in ("stopped", "error"):
                w._status = "stopped"
        self._flush_once()
        self._stop.set()
        self._wake.set()
        if self.transport:
            self.transport.close()

    # workers -------------------------------------------------------------
    def worker(self, name: str) -> Worker:
        self._ensure()
        with self._lock:
            if name not in self.workers:
                self.workers[name] = Worker(self, name)
                self._presence_dirty.set()
            return self.workers[name]

    def remove_worker(self, name: str):
        with self._lock:
            w = self.workers.pop(name, None)
        if w:
            w._status = "stopped"
            self._presence_dirty.set()

    @property
    def current_worker(self) -> Worker | None:
        return _current_worker.get()

    # logs ----------------------------------------------------------------
    def log(self, level: str, message: str, *, worker: Worker | None = None, exc_info=None,
            source: str = "", **context):
        self._ensure()
        level = level.lower()
        if level not in LEVELS:
            level = "info"
        worker = worker or _current_worker.get()
        entry = {"ts": _now(), "level": level, "message": str(message)[:8000], "source": source}
        if worker:
            entry["worker_id"] = worker.id
            entry["worker_name"] = worker.name
        if context:
            entry["context"] = _jsonable(context)
        if exc_info:
            if exc_info is True:
                entry["exception"] = traceback.format_exc()[-16000:]
            else:
                entry["exception"] = "".join(traceback.format_exception(*exc_info))[-16000:]
        self._push(self._logs, entry)
        if level in ("error", "critical"):
            self._wake.set()

    def debug(self, message, **kw):
        self.log("debug", message, **kw)

    def info(self, message, **kw):
        self.log("info", message, **kw)

    def warning(self, message, **kw):
        self.log("warning", message, **kw)

    def error(self, message, **kw):
        self.log("error", message, **kw)

    def critical(self, message, **kw):
        self.log("critical", message, **kw)

    def install_logging(self, level: int = logging.INFO, logger: logging.Logger | None = None) -> "HubLogHandler":
        """Forward stdlib ``logging`` records (yours and libraries') to the hub."""
        self._ensure()
        handler = HubLogHandler(self, level)
        (logger or logging.getLogger()).addHandler(handler)
        if (logger or logging.getLogger()).level > level or (logger or logging.getLogger()).level == logging.NOTSET:
            (logger or logging.getLogger()).setLevel(level)
        return handler

    # metrics -------------------------------------------------------------
    def metric(self, name: str, value: float = 1, *, kind: str = "count", worker: Worker | None = None, **labels):
        """``count`` values are summed over time; ``gauge`` and ``duration`` are averaged."""
        self._ensure()
        if kind not in ("count", "gauge", "duration"):
            raise ValueError("kind must be count, gauge or duration")
        worker = worker or _current_worker.get()
        self._push(self._metrics, {"ts": _now(), "name": name, "kind": kind, "value": float(value),
                                   "worker_id": worker.id if worker else None, "labels": _jsonable(labels)})

    def count(self, name: str, value: float = 1, **kw):
        self.metric(name, value, kind="count", **kw)

    def gauge(self, name: str, value: float, **kw):
        self.metric(name, value, kind="gauge", **kw)

    def timing(self, name: str, seconds: float, **kw):
        self.metric(name, seconds, kind="duration", **kw)

    # costs ---------------------------------------------------------------
    def set_price(self, provider: str, amount: float, *, currency: str = "USD", unit: str | None = None):
        """Default price per unit for ``add_cost(provider=...)`` without an amount."""
        self._costs.price(provider, amount, currency, unit)

    def add_cost(self, amount: float | None = None, provider: str = "other", category: str = "other", *,
                 quantity: float = 1, unit: str | None = None, currency: str = "USD",
                 worker: Worker | None = None, meta: dict | None = None, breakdown: bool = False):
        """Record spending wherever it happens. Entries are aggregated locally and
        sent every few seconds; pass ``breakdown=True`` (or ``meta``) to send
        this entry individually."""
        self._ensure()
        worker = worker or _current_worker.get()
        self._costs.add(amount, provider, category, quantity, unit, currency,
                        worker.id if worker else None, _jsonable(meta) if meta else None, breakdown)

    addCost = add_cost  # noqa: N815 — matches the Node SDK name

    def cost(self, provider: str, category: str = "other", **kw) -> Cost:
        return Cost(self, provider, category, **kw)

    def cost_summary(self) -> dict:
        """Running totals since this process started: {currency: {provider: amount}}."""
        return self._costs.summary()

    def balance(self, provider: str, amount: float, *, currency: str = "USD", low: float | None = None, label: str = ""):
        """Report a provider's remaining balance; ``low`` sets the alert threshold."""
        self._ensure()
        with self._lock:
            self._balances[(provider, label)] = {"provider": provider, "label": label, "balance": float(amount),
                                                 "currency": currency.upper(), "low_threshold": low}

    # proxies -------------------------------------------------------------
    def proxy(self, label: str, state: str, *, key: str | None = None, url: str | None = None, detail: str = ""):
        """state: ok | slow | blocked | auth | timeout. Pass ``url`` (credentials are
        hashed away, never sent) or a stable ``key``."""
        self._ensure()
        if state not in ("ok", "slow", "blocked", "auth", "timeout", "unknown"):
            raise ValueError("Unknown proxy state")
        if not key:
            key = proxy_key(url) if url else label
        self._push(self._proxies, {"ts": _now(), "key": key, "label": label, "state": state, "detail": str(detail)[:500]})

    # issues --------------------------------------------------------------
    def issue(self, title: str, detail: str = "", *, severity: str = "warning", key: str | None = None,
              worker: Worker | None = None, **data):
        """Tell the hub something needs a human. Forwarded to Discord/Telegram by
        the alert engine; the same ``key`` is deduplicated while it stays open."""
        self._ensure()
        worker = worker or _current_worker.get()
        self._push(self._issues, {"title": title, "detail": detail, "severity": severity,
                                  "key": key or f"{self.site_key}:{worker.name if worker else 'script'}:{title}",
                                  "worker_id": worker.id if worker else None, "data": _jsonable(data)})
        self._wake.set()

    # commands ------------------------------------------------------------
    def on_command(self, name: str, handler: Callable[..., Any] | None = None, *, description: str = "",
                   args: dict | None = None):
        """Register a handler. Built-ins you may implement: ``pause``, ``resume``,
        ``set_workers`` (args: count), ``reload_config``, ``stop``. Anything else is
        a custom command shown in the dashboard and bots."""
        def register(func):
            self._handlers[name] = (func, description, args or {})
            self._presence_dirty.set()
            return func
        self._ensure()
        return register(handler) if handler else register

    def on_config_change(self, callback: Callable[[str], Any]):
        """Called with the path after the hub rewrote a config file."""
        self._ensure()
        self._config_callbacks.append(callback)
        return callback

    def wait_if_paused(self, poll: float = 1.0):
        """Block the caller while the site is paused (call at the top of work loops)."""
        while self.paused.is_set() and not self.stopping.is_set():
            time.sleep(poll)

    def _handle_command(self, message: dict):
        action = message.get("action", "")
        command_id = message.get("command_id")
        name = action.split(":", 1)[1] if action.startswith("custom:") else action
        args = message.get("args") or {}
        if name == "pause":
            self.paused.set()
        elif name == "resume":
            self.paused.clear()
        elif name == "set_workers" and isinstance(args.get("count"), int):
            self.desired_workers = args["count"]
        elif name == "stop":
            self.stopping.set()
        entry = self._handlers.get(name)
        if entry is None:
            if name in ("pause", "resume", "stop"):
                self._ack(command_id, "completed", f"{name} flag set")
            else:
                self._ack(command_id, "failed", f"Script has no handler for '{name}'")
            return

        def run():
            try:
                result = entry[0](**args) if args else entry[0]()
                self._ack(command_id, "completed", "" if result is None else str(result)[:2000])
            except Exception as exc:  # report, never crash the script
                self.log("error", f"Command {name} failed: {exc}", exc_info=True)
                self._ack(command_id, "failed", str(exc)[:2000])
        threading.Thread(target=run, name=f"bambouhub-cmd-{name}", daemon=True).start()

    def _ack(self, command_id, status, message=""):
        if command_id:
            self._push(self._acks, {"command_id": command_id, "status": status, "message": message})
            self._wake.set()

    def _files_changed(self, paths):
        for path in paths or []:
            for callback in self._config_callbacks:
                try:
                    callback(path)
                except Exception:
                    self.log("error", f"Config change callback failed for {path}", exc_info=True)

    # transport -----------------------------------------------------------
    def _push(self, queue: deque, item: dict):
        if len(queue) == queue.maxlen:
            self.dropped += 1
        queue.append(item)

    def _capabilities(self) -> dict:
        return {"sdk": SDK, "commands": [{"name": n, "description": d, "args": a}
                                         for n, (_, d, a) in sorted(self._handlers.items())]}

    def _drain(self) -> dict:
        def take(queue: deque, limit=5000):
            out = []
            while queue and len(out) < limit:
                out.append(queue.popleft())
            return out
        with self._lock:
            balances = list(self._balances.values())
            self._balances = {}
            workers = [w.snapshot() for w in self.workers.values()]
        batch = {"logs": take(self._logs), "metrics": take(self._metrics), "costs": self._costs.drain(),
                 "balances": balances, "proxies": take(self._proxies), "issues": take(self._issues, 200),
                 "acks": take(self._acks, 200),
                 "presence": {"workers": workers, "capabilities": self._capabilities(), "paused": self.paused.is_set(),
                              "dropped": self.dropped}}
        return batch

    def _requeue(self, batch: dict):
        """Put an unsent batch back at the front so nothing is lost."""
        for key, queue in (("logs", self._logs), ("metrics", self._metrics), ("proxies", self._proxies),
                           ("issues", self._issues), ("acks", self._acks)):
            for item in reversed(batch.get(key, [])):
                if len(queue) < queue.maxlen:
                    queue.appendleft(item)
        for cost in batch.get("costs", []):
            self._costs.individual.insert(0, cost)
        with self._lock:
            for item in batch.get("balances", []):
                self._balances.setdefault((item["provider"], item["label"]), item)

    def _flush_once(self) -> bool:
        if not self.transport:
            return False
        batch = self._drain()
        try:
            self.transport.send(batch)
            return True
        except Exception as exc:
            self._requeue(batch)
            _LOG.debug("bambouhub flush failed: %s", exc)
            return False

    def flush(self) -> bool:
        """Send buffered data now (normally automatic)."""
        self._ensure()
        return self._flush_once()

    def _flusher(self):
        backoff = self.flush_interval
        while not self._stop.is_set():
            self._wake.wait(backoff)
            self._wake.clear()
            if self._stop.is_set():
                break
            ok = self._flush_once()
            backoff = self.flush_interval if ok else min(backoff * 2, 30)


class HubLogHandler(logging.Handler):
    """stdlib logging → hub. Attributes records to the bound worker."""

    def __init__(self, hub: Hub, level=logging.INFO):
        super().__init__(level)
        self.hub = hub

    def emit(self, record: logging.LogRecord):
        if record.name.startswith("bambouhub"):
            return
        try:
            level = {logging.DEBUG: "debug", logging.INFO: "info", logging.WARNING: "warning",
                     logging.ERROR: "error", logging.CRITICAL: "critical"}.get(record.levelno, "info")
            self.hub.log(level, record.getMessage(), source=record.name,
                         exc_info=record.exc_info if record.exc_info else None)
        except Exception:
            self.handleError(record)


# ---------------------------------------------------------------------------
# Transports
# ---------------------------------------------------------------------------

class _Transport:
    def send(self, batch: dict):
        raise NotImplementedError

    def close(self):
        pass


class _NullTransport(_Transport):
    """No agent and no hub configured: keep the script running, drop telemetry."""

    def send(self, batch: dict):
        return None


class _SocketTransport(_Transport):
    """Newline-delimited JSON over the agent's unix socket (both directions)."""

    def __init__(self, hub: Hub, path: str):
        self.hub = hub
        self.path = path
        self.sock: socket.socket | None = None
        self.lock = threading.Lock()
        self.reader: threading.Thread | None = None

    def _connect(self):
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.settimeout(10)
        sock.connect(self.path)
        sock.settimeout(None)
        hello = {"type": "hello", "pid": os.getpid(), "sdk": SDK}
        sock.sendall((json.dumps(hello) + "\n").encode())
        self.sock = sock
        self.reader = threading.Thread(target=self._read, args=(sock,), name="bambouhub-read", daemon=True)
        self.reader.start()

    def _read(self, sock: socket.socket):
        buffer = b""
        try:
            while True:
                chunk = sock.recv(65536)
                if not chunk:
                    break
                buffer += chunk
                while b"\n" in buffer:
                    line, buffer = buffer.split(b"\n", 1)
                    if line.strip():
                        self._dispatch(json.loads(line))
        except (OSError, ValueError):
            pass
        finally:
            with self.lock:
                if self.sock is sock:
                    self.sock = None

    def _dispatch(self, message: dict):
        kind = message.get("type")
        if kind == "command":
            self.hub._handle_command(message)
        elif kind == "files_changed":
            self.hub._files_changed(message.get("paths"))
        elif kind == "state":
            if message.get("paused"):
                self.hub.paused.set()
            else:
                self.hub.paused.clear()
            if isinstance(message.get("desired_workers"), int):
                self.hub.desired_workers = message["desired_workers"]

    def send(self, batch: dict):
        data = (json.dumps({"type": "batch", **batch}, default=str) + "\n").encode()
        with self.lock:
            if self.sock is None:
                self._connect()
            try:
                self.sock.sendall(data)
            except OSError:
                self.sock = None
                raise

    def close(self):
        with self.lock:
            if self.sock:
                try:
                    self.sock.close()
                except OSError:
                    pass
                self.sock = None


class _HttpTransport(_Transport):
    """Direct mode for scripts not started by bambou-agent. Commands are polled."""

    def __init__(self, hub: Hub, url: str, token: str):
        self.hub = hub
        self.url = url.rstrip("/")
        self.token = token
        self.last_poll = 0.0

    def _request(self, method: str, path: str, body: dict | None = None):
        import urllib.request
        data = json.dumps(body, default=str).encode() if body is not None else None
        request = urllib.request.Request(self.url + path, data=data, method=method, headers={
            "Authorization": f"Bearer {self.token}", "Content-Type": "application/json", "User-Agent": SDK})
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.loads(response.read() or b"null")

    def send(self, batch: dict):
        reply = self._request("POST", "/api/agent/v2/batch", batch)
        if isinstance(reply, dict):
            if reply.get("desired_state") == "paused":
                self.hub.paused.set()
            elif reply.get("desired_state") == "running":
                self.hub.paused.clear()
        if time.time() - self.last_poll >= 5:
            self.last_poll = time.time()
            for command in self._request("GET", "/api/agent/v2/commands") or []:
                if command.get("action") in ("start", "stop", "restart"):
                    # Without an agent nothing can restart the process; let the script decide.
                    if command["action"] == "stop":
                        self.hub.stopping.set()
                    self.hub._ack(command["command_id"], "completed" if command["action"] == "stop" else "failed",
                                  "" if command["action"] == "stop" else "Direct mode: run under bambou-agent for start/restart")
                    continue
                self.hub._handle_command(command)


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

def proxy_key(url: str) -> str:
    """Same key the hub computes for proxies in proxies.txt (scheme|host|port|username)."""
    import hashlib
    from urllib.parse import unquote, urlsplit
    text = url if "://" in url else "http://" + url
    if "://" in url or "@" in url:
        parts = urlsplit(text)
        scheme, host, port, user = parts.scheme.lower(), parts.hostname or "", parts.port or 0, unquote(parts.username or "")
    else:
        pieces = url.split(":", 3)
        scheme, host, port, user = "http", pieces[0], int(pieces[1]) if len(pieces) > 1 else 0, pieces[2] if len(pieces) > 2 else ""
    return hashlib.sha256(f"{scheme}|{host.lower()}|{port}|{user}".encode()).hexdigest()[:16]


def _jsonable(value, depth=0):
    if depth > 4:
        return str(value)[:200]
    if isinstance(value, dict):
        return {str(k)[:100]: _jsonable(v, depth + 1) for k, v in list(value.items())[:50]}
    if isinstance(value, (list, tuple, set)):
        return [_jsonable(v, depth + 1) for v in list(value)[:50]]
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value[:2000] if isinstance(value, str) else value
    return str(value)[:2000]
