"""Alert engine: rule evaluation, deduplication, and delivery queueing.

Alerts are opened with a ``dedup_key``. While an alert with that key is open,
re-triggering only bumps ``updated_at`` (no new notification). When the
condition clears the alert resolves automatically and a resolution notice is
sent. Muted alerts stay quiet until ``muted_until``.

Delivery: every open/resolve creates rows in ``alert_deliveries`` for the rule's
channels (or the default channels). The bot process pulls/streams these, sends
them, and reports the outcome; the hub never holds Discord/Telegram tokens.
"""

from __future__ import annotations

import json
import logging
from datetime import datetime, timedelta, timezone

LOG = logging.getLogger("hub.alerts")

RULE_KINDS = {
    "worker_idle": "A worker reports 'idle' for longer than params.minutes (default 15)",
    "worker_error": "A worker is in 'error' state",
    "worker_silent": "A worker stopped reporting for params.minutes (default 5) while the site should run",
    "site_offline": "The site's agent has not reported for params.minutes (default 2)",
    "error_spike": "At least params.count error logs (default 20) within params.minutes (default 5)",
    "cost_daily": "Today's spend exceeds params.amount in params.currency (default USD)",
    "balance_low": "A reported provider balance is at or below its threshold (or params.amount)",
    "backup_failed": "The latest backup failed or is older than params.hours (default 48)",
    "proxy_failing": "At least params.percent (default 50) of a site's proxies are failing",
    "issue": "Script-reported issues (always on; this rule only sets channels/severity)",
}


def _now():
    return datetime.now(timezone.utc)


def default_rules() -> list[dict]:
    return [
        {"name": "Site offline", "kind": "site_offline", "params": {"minutes": 2}, "severity": "critical"},
        {"name": "Worker in error", "kind": "worker_error", "params": {}, "severity": "warning"},
        {"name": "Worker idle 15m", "kind": "worker_idle", "params": {"minutes": 15}, "severity": "warning"},
        {"name": "Worker silent", "kind": "worker_silent", "params": {"minutes": 5}, "severity": "warning"},
        {"name": "Error spike", "kind": "error_spike", "params": {"count": 20, "minutes": 5}, "severity": "warning"},
        {"name": "Low balance", "kind": "balance_low", "params": {}, "severity": "warning"},
        {"name": "Backup failed", "kind": "backup_failed", "params": {"hours": 48}, "severity": "warning"},
        {"name": "Proxies failing", "kind": "proxy_failing", "params": {"percent": 50}, "severity": "warning"},
        {"name": "Script issues", "kind": "issue", "params": {}, "severity": "warning"},
    ]


def ensure_default_rules(db):
    if db.one("SELECT 1 AS x FROM alert_rules LIMIT 1"):
        return
    for rule in default_rules():
        db.execute("INSERT INTO alert_rules(name, kind, params, severity) VALUES(%s,%s,%s::jsonb,%s)",
                   (rule["name"], rule["kind"], json.dumps(rule["params"]), rule["severity"]))


def default_channels(db) -> list[dict]:
    row = db.one("SELECT value FROM hub_settings WHERE key='alert_channels'")
    return row["value"] if row and isinstance(row["value"], list) else []


def open_alert(app, rule: dict | None, site_id: str | None, worker_id: str | None, dedup_key: str,
               severity: str, title: str, body: str = "", data: dict | None = None) -> str:
    db = app.state.db
    with db.transaction() as cur:
        cur.execute("SELECT * FROM alerts WHERE dedup_key=%s AND status IN ('open','acknowledged','muted') "
                    "ORDER BY opened_at DESC LIMIT 1 FOR UPDATE", (dedup_key,))
        existing = cur.fetchone()
        if existing:
            cur.execute("UPDATE alerts SET updated_at=now(), body=%s, data=%s::jsonb WHERE id=%s",
                        (body, json.dumps(data or {}, default=str), existing["id"]))
            return str(existing["id"])
        if rule and rule.get("cooldown_seconds"):
            cur.execute("SELECT resolved_at FROM alerts WHERE dedup_key=%s AND status='resolved' ORDER BY resolved_at DESC LIMIT 1",
                        (dedup_key,))
            last = cur.fetchone()
            if last and last["resolved_at"] and (_now() - last["resolved_at"]).total_seconds() < rule["cooldown_seconds"] / 3:
                # Flapping: re-open quietly without another notification burst.
                cur.execute("UPDATE alerts SET status='open', updated_at=now(), resolved_at=NULL WHERE id=("
                            "SELECT id FROM alerts WHERE dedup_key=%s AND status='resolved' ORDER BY resolved_at DESC LIMIT 1) RETURNING id",
                            (dedup_key,))
                return str(cur.fetchone()["id"])
        cur.execute("INSERT INTO alerts(rule_id, site_id, worker_id, dedup_key, severity, title, body, data) "
                    "VALUES(%s,%s,%s,%s,%s,%s,%s,%s::jsonb) RETURNING *",
                    (rule["id"] if rule else None, site_id, worker_id, dedup_key, severity, title, body,
                     json.dumps(data or {}, default=str)))
        alert = cur.fetchone()
        channels = (rule or {}).get("channels") or default_channels(db)
        if not rule:
            issue_rule = db.one("SELECT * FROM alert_rules WHERE kind='issue' AND enabled AND (site_id IS NULL OR site_id=%s) "
                                "ORDER BY site_id NULLS LAST LIMIT 1", (site_id,))
            if issue_rule is None and db.one("SELECT 1 AS x FROM alert_rules WHERE kind='issue'"):
                return str(alert["id"])  # issue alerts explicitly disabled: record only
            if issue_rule and issue_rule["channels"]:
                channels = issue_rule["channels"]
        for channel in channels:
            cur.execute("INSERT INTO alert_deliveries(alert_id, platform, channel) VALUES(%s,%s,%s)",
                        (alert["id"], channel.get("platform", ""), str(channel.get("chat_id", ""))))
    view = alert_view(alert, site_name(db, site_id))
    app.state.realtime.publish({"type": "alert", "event": "opened", "alert": view, "channels": channels})
    return str(alert["id"])


def resolve(app, dedup_key: str, note: str = "") -> bool:
    db = app.state.db
    row = db.one("UPDATE alerts SET status='resolved', resolved_at=now(), updated_at=now() "
                 "WHERE dedup_key=%s AND status IN ('open','acknowledged') RETURNING *", (dedup_key,))
    if not row:
        return False
    app.state.realtime.publish({"type": "alert", "event": "resolved", "alert": alert_view(row, site_name(db, row["site_id"])),
                                "note": note})
    return True


def site_name(db, site_id) -> str:
    if not site_id:
        return ""
    row = db.one("SELECT name FROM sites WHERE id=%s", (site_id,))
    return row["name"] if row else ""


def alert_view(row: dict, site: str = "") -> dict:
    return {"id": str(row["id"]), "site_id": str(row["site_id"]) if row["site_id"] else None, "site_name": site,
            "worker_id": str(row["worker_id"]) if row["worker_id"] else None, "severity": row["severity"],
            "title": row["title"], "body": row["body"], "data": row["data"], "status": row["status"],
            "opened_at": row["opened_at"], "updated_at": row["updated_at"], "resolved_at": row["resolved_at"],
            "muted_until": row["muted_until"], "dedup_key": row["dedup_key"]}


# -- evaluation -----------------------------------------------------------------

def evaluate(app) -> None:
    """Run every enabled rule once. Called periodically by the task runner."""
    db = app.state.db
    db.execute("UPDATE alerts SET status='open', muted_until=NULL WHERE status='muted' AND muted_until < now()")
    rules = db.query("SELECT * FROM alert_rules WHERE enabled ORDER BY created_at")
    sites = db.query("SELECT * FROM sites WHERE archived_at IS NULL")
    active: set[str] = set()
    for rule in rules:
        handler = _HANDLERS.get(rule["kind"])
        if not handler:
            continue
        for site in sites:
            if rule["site_id"] and rule["site_id"] != site["id"]:
                continue
            try:
                for key, worker_id, title, body, data in handler(app, rule, site):
                    active.add(key)
                    open_alert(app, rule, str(site["id"]), worker_id, key, rule["severity"], title, body, data)
            except Exception:  # one bad rule must not stop the rest
                LOG.exception("Alert rule %s failed", rule["name"])
    # Auto-resolve rule alerts whose condition cleared (issues resolve explicitly).
    for row in db.query("SELECT dedup_key FROM alerts WHERE status IN ('open','acknowledged') AND rule_id IS NOT NULL"):
        if row["dedup_key"] not in active:
            resolve(app, row["dedup_key"], "Condition cleared")


def _minutes(rule, default):
    try:
        return max(1, int(rule["params"].get("minutes", default)))
    except (TypeError, ValueError):
        return default


def _site_offline(app, rule, site):
    if site["desired_state"] == "stopped" and not app.state.db.one("SELECT 1 AS x FROM agent_reports WHERE site_id=%s", (site["id"],)):
        return []
    report = app.state.db.one("SELECT last_seen_at FROM agent_reports WHERE site_id=%s", (site["id"],))
    if not report or not report["last_seen_at"]:
        return []
    minutes = _minutes(rule, 2)
    if app.state.realtime.is_online(str(site["id"])):
        return []
    age = (_now() - report["last_seen_at"]).total_seconds()
    if age < minutes * 60:
        return []
    return [(f"offline:{site['id']}", None, f"{site['name']} is offline",
             f"No agent report for {int(age // 60)} minutes.", {"last_seen_at": report["last_seen_at"]})]


def _worker_state(state):
    def handler(app, rule, site):
        if site["desired_state"] != "running":
            return []
        minutes = _minutes(rule, 15) if state == "idle" else 0
        rows = app.state.db.query(
            "SELECT w.id, w.name, w.detail, min(s.ts) AS since FROM workers w "
            "LEFT JOIN LATERAL (SELECT ts FROM worker_samples ws WHERE ws.site_id=w.site_id AND ws.worker_id=w.id "
            "  AND ws.ts > now() - interval '1 day' AND ws.ts > COALESCE((SELECT max(ts) FROM worker_samples x WHERE x.site_id=w.site_id "
            "  AND x.worker_id=w.id AND x.status <> %s AND x.ts > now() - interval '1 day'), '-infinity')) s ON true "
            "WHERE w.site_id=%s AND w.status=%s AND w.last_seen_at > now() - interval '10 minutes' GROUP BY w.id",
            (state, site["id"], state))
        out = []
        for row in rows:
            since = row["since"] or _now()
            if (_now() - since).total_seconds() >= minutes * 60:
                reason = (row["detail"] or {}).get("reason", "")
                title = f"{site['name']} / {row['name']} is {state}"
                body = (f"For {int((_now() - since).total_seconds() // 60)} min." + (f" Reason: {reason}" if reason else ""))
                out.append((f"worker_{state}:{row['id']}", str(row["id"]), title, body, {"worker": row["name"]}))
        return out
    return handler


def _worker_silent(app, rule, site):
    if site["desired_state"] != "running" or not app.state.realtime.is_online(str(site["id"])):
        return []
    minutes = _minutes(rule, 5)
    rows = app.state.db.query(
        "SELECT id, name, last_seen_at FROM workers WHERE site_id=%s AND status NOT IN ('stopped') "
        "AND last_seen_at < now() - (%s * interval '1 minute') AND last_seen_at > now() - interval '1 day'",
        (site["id"], minutes))
    return [(f"worker_silent:{r['id']}", str(r["id"]), f"{site['name']} / {r['name']} stopped reporting",
             f"Last report {r['last_seen_at']:%H:%M UTC}.", {"worker": r["name"]}) for r in rows]


def _error_spike(app, rule, site):
    minutes = _minutes(rule, 5)
    try:
        threshold = max(1, int(rule["params"].get("count", 20)))
    except (TypeError, ValueError):
        threshold = 20
    row = app.state.db.one("SELECT count(*) AS n FROM event_logs WHERE site_id=%s AND level>=4 AND ts > now() - (%s * interval '1 minute')",
                           (site["id"], minutes))
    if row["n"] < threshold:
        return []
    sample = app.state.db.one("SELECT message FROM event_logs WHERE site_id=%s AND level>=4 ORDER BY id DESC LIMIT 1", (site["id"],))
    return [(f"error_spike:{site['id']}", None, f"{site['name']}: {row['n']} errors in {minutes} min",
             f"Latest: {sample['message'][:300] if sample else ''}", {"count": row["n"]})]


def _cost_daily(app, rule, site):
    try:
        limit = float(rule["params"].get("amount"))
    except (TypeError, ValueError):
        return []
    currency = str(rule["params"].get("currency", "USD")).upper()
    row = app.state.db.one("SELECT COALESCE(sum(amount), 0) AS total FROM cost_events WHERE site_id=%s AND currency=%s "
                           "AND ts >= date_trunc('day', now())", (site["id"], currency))
    total = float(row["total"])
    if total <= limit:
        return []
    return [(f"cost_daily:{site['id']}:{_now():%Y%m%d}", None, f"{site['name']} spent {total:.2f} {currency} today",
             f"Daily limit is {limit:.2f} {currency}.", {"total": total, "limit": limit})]


def _balance_low(app, rule, site):
    override = rule["params"].get("amount")
    rows = app.state.db.query("SELECT * FROM account_balances WHERE site_id=%s", (site["id"],))
    out = []
    for row in rows:
        threshold = row["low_threshold"] if override is None else override
        if threshold is None or float(row["balance"]) > float(threshold):
            continue
        label = row["provider"] + (f" ({row['label']})" if row["label"] else "")
        out.append((f"balance_low:{site['id']}:{row['provider']}:{row['label']}", None,
                    f"{site['name']}: {label} balance low",
                    f"{float(row['balance']):.2f} {row['currency']} (threshold {float(threshold):.2f}).",
                    {"provider": row["provider"], "balance": float(row["balance"])}))
    return out


def _backup_failed(app, rule, site):
    config = app.state.db.one("SELECT enabled FROM site_backup_config WHERE site_id=%s", (site["id"],))
    if not config or not config["enabled"]:
        return []
    try:
        hours = max(1, int(rule["params"].get("hours", 48)))
    except (TypeError, ValueError):
        hours = 48
    latest = app.state.db.one("SELECT status, created_at FROM backups WHERE site_id=%s ORDER BY created_at DESC LIMIT 1", (site["id"],))
    if latest and latest["status"] == "failed":
        return [(f"backup_failed:{site['id']}", None, f"{site['name']}: latest backup failed", "", {})]
    last_ok = app.state.db.one("SELECT max(created_at) AS ts FROM backups WHERE site_id=%s AND status='completed'", (site["id"],))
    if not last_ok or not last_ok["ts"] or (_now() - last_ok["ts"]).total_seconds() > hours * 3600:
        site_age = (_now() - site["created_at"]).total_seconds()
        if site_age > hours * 3600:
            return [(f"backup_stale:{site['id']}", None, f"{site['name']}: no successful backup in {hours}h", "", {})]
    return []


def _proxy_failing(app, rule, site):
    try:
        percent = float(rule["params"].get("percent", 50))
    except (TypeError, ValueError):
        percent = 50
    rows = app.state.db.query(
        "SELECT DISTINCT ON (proxy_key) proxy_key, state FROM proxy_observations WHERE site_id=%s AND ts > now() - interval '30 minutes' "
        "ORDER BY proxy_key, ts DESC", (site["id"],))
    if len(rows) < 2:
        return []
    failing = sum(r["state"] in ("blocked", "auth", "timeout") for r in rows)
    share = 100 * failing / len(rows)
    if share < percent:
        return []
    return [(f"proxy_failing:{site['id']}", None, f"{site['name']}: {failing}/{len(rows)} proxies failing",
             f"{share:.0f}% of recently used proxies are blocked, timing out or rejecting auth.", {"failing": failing, "total": len(rows)})]


_HANDLERS = {
    "site_offline": _site_offline,
    "worker_idle": _worker_state("idle"),
    "worker_error": _worker_state("error"),
    "worker_silent": _worker_silent,
    "error_spike": _error_spike,
    "cost_daily": _cost_daily,
    "balance_low": _balance_low,
    "backup_failed": _backup_failed,
    "proxy_failing": _proxy_failing,
}
