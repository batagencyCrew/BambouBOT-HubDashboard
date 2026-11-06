"""Shared write paths used by the HTTP agent API and the WebSocket agent API."""

from __future__ import annotations

import json
import logging
from datetime import datetime, timezone

LOG = logging.getLogger("hub.ingest")

LEVELS = {"debug": 0, "info": 1, "notice": 2, "warning": 3, "error": 4, "critical": 5}


def _principal(source="agent"):
    from .permissions import Principal, PERMISSIONS
    return Principal(None, "agent", "owner", frozenset(PERMISSIONS), None, source=source)


# -- presence / heartbeat ---------------------------------------------------

def handle_presence(app, site_id: str, message: dict) -> None:
    db = app.state.db
    workers = message.get("workers") or []
    if not isinstance(workers, list) or len(workers) > 500:
        return
    now = datetime.now(timezone.utc)
    with db.transaction() as cur:
        cur.execute(
            "INSERT INTO agent_reports(site_id, last_seen_at, agent_version, host, script_process, backup_state, updated_at) "
            "VALUES(%s,%s,%s,%s::jsonb,%s::jsonb,%s::jsonb,now()) "
            "ON CONFLICT(site_id) DO UPDATE SET last_seen_at=excluded.last_seen_at, agent_version=excluded.agent_version, "
            "host=excluded.host, script_process=excluded.script_process, backup_state=excluded.backup_state, updated_at=now()",
            (site_id, now, str(message.get("agent_version", ""))[:50],
             json.dumps(_bounded(message.get("host") or {})),
             json.dumps(_bounded(message.get("process") or {})),
             json.dumps(_bounded(message.get("backup") or {}))))
        seen = []
        for worker in workers:
            try:
                wid = str(worker["id"])
                name = str(worker["name"])[:100]
                status = worker.get("status", "unknown")
                if status not in ("starting", "running", "idle", "error", "stopped", "unknown"):
                    status = "unknown"
            except (KeyError, TypeError):
                continue
            seen.append(wid)
            cur.execute(
                "INSERT INTO workers(id, site_id, name, status, detail, pid, cpu_percent, memory_mb, tasks_completed, last_seen_at) "
                "VALUES(%s,%s,%s,%s,%s::jsonb,%s,%s,%s,%s,%s) "
                "ON CONFLICT (id) DO UPDATE SET name=excluded.name, status=excluded.status, detail=excluded.detail, "
                "pid=excluded.pid, cpu_percent=excluded.cpu_percent, memory_mb=excluded.memory_mb, "
                "tasks_completed=excluded.tasks_completed, last_seen_at=excluded.last_seen_at",
                (wid, site_id, name, status, json.dumps(_bounded(worker.get("detail") or {})),
                 _int(worker.get("pid"), 0, 2**31 - 1), _float(worker.get("cpu_percent")),
                 _float(worker.get("memory_mb")), _int(worker.get("tasks_completed"), 0, 2**63 - 1), now))
            cur.execute(
                "INSERT INTO worker_samples(site_id, worker_id, ts, status, cpu_percent, memory_mb, tasks_completed) "
                "VALUES(%s,%s,%s,%s,%s,%s,%s)",
                (site_id, wid, now, status, _float(worker.get("cpu_percent")),
                 _float(worker.get("memory_mb")), _int(worker.get("tasks_completed"), 0, 2**63 - 1)))
        cur.execute(
            "UPDATE workers SET status='stopped', last_seen_at=%s WHERE site_id=%s AND NOT (id = ANY(%s::uuid[]))"
            " AND status <> 'stopped'", (now, site_id, seen))


def presence_reply(app, site_id: str) -> dict:
    db = app.state.db
    site = db.one("SELECT desired_state FROM sites WHERE id=%s", (site_id,)) or {}
    revision = db.one("SELECT COALESCE(MAX(revision), 0) AS revision FROM site_files WHERE site_id=%s", (site_id,)) or {"revision": 0}
    return {"type": "presence_ok", "desired_state": site.get("desired_state", "stopped"),
            "config_revision": revision["revision"], "online": app.state.realtime.is_online(site_id)}


# -- commands ---------------------------------------------------------------

def open_commands(app, site_id: str) -> list[dict]:
    rows = app.state.db.query(
        "SELECT id, action, args, status FROM commands WHERE site_id=%s AND status IN ('pending','delivered') "
        "ORDER BY created_at", (site_id,))
    app.state.db.execute(
        "UPDATE commands SET status='delivered', delivered_at=now() WHERE site_id=%s AND status='pending'", (site_id,))
    return [{"command_id": str(r["id"]), "action": r["action"], "args": r["args"]} for r in rows]


def handle_ack(app, site_id: str, message: dict) -> None:
    command_id = message.get("command_id")
    status = message.get("status")
    if status not in ("running", "completed", "failed") or not command_id:
        return
    app.state.db.execute(
        "UPDATE commands SET status=%s, completed_at=CASE WHEN %s IN ('completed','failed') THEN now() ELSE completed_at END, "
        "result=%s WHERE id=%s AND site_id=%s AND status IN ('pending','delivered','running')",
        (status, status, str(message.get("message", ""))[:4000], command_id, site_id))
    if status in ("completed", "failed"):
        row = app.state.db.one("SELECT * FROM commands WHERE id=%s", (command_id,))
        if row:
            app.state.realtime.publish({"type": "command", "site_id": site_id,
                                        "command": _command_view(row)})


def handle_command_result(app, site_id: str, message: dict) -> None:
    handle_ack(app, site_id, message)


def _command_view(row: dict) -> dict:
    return {k: (str(row[k]) if k in ("id", "site_id") else row[k])
            for k in ("id", "site_id", "action", "args", "status", "created_at", "completed_at", "result", "source")}


# -- telemetry --------------------------------------------------------------

def ingest_logs(app, site_id: str, entries: list[dict]) -> int:
    if not entries:
        return 0
    entries = entries[: app.state.settings.log_ingest_batch]
    rows = []
    for entry in entries:
        if not isinstance(entry, dict) or not entry.get("message"):
            continue
        level = LEVELS.get(str(entry.get("level", "info")).lower())
        if level is None:
            continue
        ts = _ts(entry.get("ts"))
        rows.append((site_id, _uuid_or_none(entry.get("worker_id")),
                     str(entry.get("worker_name", ""))[:100], ts, level,
                     str(entry.get("source", ""))[:200], str(entry["message"])[:8000],
                     json.dumps(_bounded(entry.get("context"))) if entry.get("context") else None,
                     str(entry.get("exception", ""))[:16000] or None))
    if not rows:
        return 0
    with app.state.db.transaction() as cur:
        cur.executemany(
            "INSERT INTO event_logs(site_id, worker_id, worker_name, ts, level, source, message, context, exception) "
            "VALUES(%s,%s,%s,%s,%s,%s,%s,%s::jsonb,%s)", rows)
    _publish_errors(app, site_id, rows)
    return len(rows)


def ingest_metrics(app, site_id: str, entries: list[dict]) -> int:
    rows = []
    for entry in entries[:2000]:
        if not isinstance(entry, dict):
            continue
        name = str(entry.get("name", ""))[:120]
        kind = entry.get("kind", "gauge")
        value = _float(entry.get("value"), allow_none=True)
        if not name or kind not in ("count", "gauge", "duration") or value is None:
            continue
        rows.append((site_id, _uuid_or_none(entry.get("worker_id")), name,
                     json.dumps(_bounded(entry.get("labels") or {})), _ts(entry.get("ts")), kind, value))
    if not rows:
        return 0
    with app.state.db.transaction() as cur:
        cur.executemany("INSERT INTO metrics(site_id, worker_id, name, labels, ts, kind, value) "
                        "VALUES(%s,%s,%s,%s::jsonb,%s,%s,%s)", rows)
    return len(rows)


def ingest_costs(app, site_id: str, events: list[dict]) -> int:
    """Money lives here, not in the script: the SDK accumulates locally and the
    hub stores individual entries so totals are exact and auditable."""
    rows = []
    for event in events[:2000]:
        if not isinstance(event, dict):
            continue
        amount = event.get("amount")
        try:
            amount = round(float(amount), 6)
        except (TypeError, ValueError):
            continue
        if amount < 0 or amount > 1_000_000_000:
            continue
        receipt = str(event.get("event_id") or event.get("receipt") or "")
        if len(receipt) < 8 or len(receipt) > 100:
            continue
        rows.append((site_id, _ts(event.get("ts")), str(event.get("category", "other"))[:50],
                     str(event.get("provider", "unknown"))[:80], amount,
                     str(event.get("currency", "USD")).upper()[:3],
                     _float(event.get("quantity"), allow_none=True), str(event.get("unit", ""))[:30] or None,
                     _uuid_or_none(event.get("worker_id")), json.dumps(_bounded(event.get("meta") or {})), receipt))
    if not rows:
        return 0
    inserted = 0
    with app.state.db.transaction() as cur:
        for row in rows:
            cur.execute(
                "INSERT INTO cost_events(site_id, ts, category, provider, amount, currency, quantity, unit, worker_id, meta, receipt) "
                "VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s::jsonb,%s) ON CONFLICT DO NOTHING", row)
            inserted += cur.rowcount
    return inserted


def ingest_balances(app, site_id: str, balances: list[dict]) -> int:
    count = 0
    with app.state.db.transaction() as cur:
        for item in balances[:200]:
            if not isinstance(item, dict):
                continue
            provider = str(item.get("provider", ""))[:80]
            balance = _float(item.get("balance"), allow_none=True)
            if not provider or balance is None:
                continue
            cur.execute(
                "INSERT INTO account_balances(site_id, provider, label, currency, balance, low_threshold, reported_at) "
                "VALUES(%s,%s,%s,%s,%s,%s,now()) ON CONFLICT (site_id, provider, label) DO UPDATE SET "
                "balance=excluded.balance, currency=excluded.currency, low_threshold=excluded.low_threshold, reported_at=now()",
                (site_id, provider, str(item.get("label", ""))[:80], str(item.get("currency", "USD")).upper()[:3],
                 balance, _float(item.get("low_threshold"), allow_none=True)))
            count += 1
    return count


def ingest_proxies(app, site_id: str, observations: list[dict]) -> int:
    count = 0
    with app.state.db.transaction() as cur:
        for item in observations[:1000]:
            if not isinstance(item, dict):
                continue
            key = str(item.get("key", ""))[:120]
            state = item.get("state")
            if not key or state not in ("ok", "slow", "blocked", "auth", "timeout", "unknown"):
                continue
            cur.execute(
                "INSERT INTO proxy_observations(site_id, proxy_key, label, state, detail, ts) VALUES(%s,%s,%s,%s,%s,%s)",
                (site_id, key, str(item.get("label", ""))[:80], state,
                 str(item.get("detail", ""))[:500], _ts(item.get("ts"))))
            count += 1
    return count


def raise_issue(app, site_id: str, issue: dict) -> str:
    """A script-detected problem (stuck worker, dead login, ...) that the alert
    engine forwards to configured channels."""
    title = str(issue.get("title", ""))[:200] or "Script issue"
    body = str(issue.get("detail", ""))[:4000]
    key = str(issue.get("key", ""))[:200] or f"issue:{site_id}:{title}"
    severity = issue.get("severity", "warning")
    if severity not in ("info", "warning", "critical"):
        severity = "warning"
    from .alerts import open_alert
    return open_alert(app, None, site_id, _uuid_or_none(issue.get("worker_id")), key,
                      severity, title, body, _bounded(issue.get("data") or {}))


def ingest_chats(app, site_id: str, chats: list[dict]) -> int:
    """Legacy v1 chat receipts, accepted for compatibility during migration."""
    count = 0
    for chat in chats[:1000]:
        if not isinstance(chat, dict):
            continue
        name = str(chat.get("name", "chats"))[:60]
        ingest_metrics(app, site_id, [{"name": f"chat.{k}", "kind": "count", "value": chat[k],
                                       "worker_id": chat.get("worker_id"), "ts": chat.get("ts")}
                                      for k in ("msgs_in", "msgs_out", "links") if k in chat])
        ingest_metrics(app, site_id, [{"name": "chat.converted", "kind": "count",
                                       "value": 1 if chat.get("converted") else 0,
                                       "worker_id": chat.get("worker_id"), "ts": chat.get("ts")}])
        count += 1
    return count


# -- helpers ----------------------------------------------------------------

def _publish_errors(app, site_id: str, rows):
    for row in rows:
        if row[4] >= 4:
            app.state.realtime.publish({"type": "log", "site_id": site_id, "level": row[4],
                                        "message": row[6], "worker_id": str(row[1]) if row[1] else None,
                                        "ts": row[3].isoformat()})


def _ts(value) -> datetime:
    if isinstance(value, str) and value:
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=timezone.utc)
            if abs((datetime.now(timezone.utc) - parsed).total_seconds()) < 7 * 86400:
                return parsed
        except ValueError:
            pass
    return datetime.now(timezone.utc)


def _uuid_or_none(value):
    if not value:
        return None
    try:
        import uuid
        return str(uuid.UUID(str(value)))
    except (ValueError, TypeError):
        return None


def _int(value, low, high, default=0):
    try:
        number = int(value)
    except (TypeError, ValueError):
        return default
    return max(low, min(high, number))


def _float(value, allow_none=False):
    if value is None and allow_none:
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return 0.0 if not allow_none else None
    if number != number or number in (float("inf"), float("-inf")):
        return 0.0 if not allow_none else None
    return max(0.0, number)


def _bounded(value, depth=0):
    """Keep jsonb payloads small and shallow; telemetry must never bloat rows."""
    if depth > 4:
        return None
    if isinstance(value, dict):
        return {str(k)[:100]: _bounded(v, depth + 1) for k, v in list(value.items())[:50]}
    if isinstance(value, list):
        return [_bounded(v, depth + 1) for v in value[:50]]
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value[:2000] if isinstance(value, str) else value
    return str(value)[:2000]
