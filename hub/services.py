"""Operations shared by every control surface (dashboard, bots, API).

Each function takes a Principal, checks the needed permission for the target
site, performs the change, and writes an audit record. Routers stay thin.
"""

from __future__ import annotations

import json
import re
from datetime import datetime, timedelta, timezone

from fastapi import HTTPException

from . import audit
from .permissions import Principal

LIFECYCLE = {
    "start": ("control:lifecycle", "running"),
    "stop": ("control:lifecycle", "stopped"),
    "restart": ("control:lifecycle", "running"),
    "pause": ("control:pause", "paused"),
    "resume": ("control:pause", "running"),
    "set_workers": ("control:workers", None),
    "reload_config": ("config:edit", None),
}
CUSTOM = re.compile(r"^custom:[a-z0-9_.-]{1,60}$")


def now():
    return datetime.now(timezone.utc)


# -- site lookups -------------------------------------------------------------

def resolve_site(db, principal: Principal, ref: str, permission: str = "sites:view") -> dict:
    """Accept a site id, slug, or case-insensitive name (bots type names)."""
    ref = (ref or "").strip()
    if not ref:
        raise HTTPException(400, "Site required")
    row = None
    if re.fullmatch(r"[0-9a-fA-F-]{36}", ref):
        row = db.one("SELECT * FROM sites WHERE id=%s AND archived_at IS NULL", (ref,))
    if row is None:
        row = db.one("SELECT * FROM sites WHERE (slug=%s OR lower(name)=lower(%s)) AND archived_at IS NULL "
                     "ORDER BY created_at LIMIT 1", (ref.lower(), ref))
    if row is None or not principal.visible_site(str(row["id"])):
        raise HTTPException(404, "Site not found")
    if not principal.can_site(permission, str(row["id"])):
        raise HTTPException(403, f"Missing permission: {permission}")
    return row


def visible_sites(db, principal: Principal) -> list[dict]:
    rows = db.query("SELECT * FROM sites WHERE archived_at IS NULL ORDER BY name")
    return [r for r in rows if principal.visible_site(str(r["id"]))]


def site_status(app, site: dict, report: dict | None, workers: list[dict]) -> dict:
    online = app.state.realtime.is_online(str(site["id"]))
    last_seen = report["last_seen_at"] if report else None
    fresh = last_seen is not None and (now() - last_seen).total_seconds() < 60
    counts = {s: 0 for s in ("running", "idle", "error", "stopped", "starting", "unknown")}
    for worker in workers:
        counts[worker["status"]] = counts.get(worker["status"], 0) + 1
    if not (online or fresh):
        health = "offline"
    elif counts["error"]:
        health = "degraded"
    else:
        health = "healthy"
    return {"health": health, "online": online, "last_seen_at": last_seen, "workers": counts,
            "worker_total": sum(counts.values()) - counts["stopped"]}


def site_summary(app, site: dict) -> dict:
    db = app.state.db
    sid = str(site["id"])
    report = db.one("SELECT * FROM agent_reports WHERE site_id=%s", (sid,))
    workers = db.query("SELECT status FROM workers WHERE site_id=%s AND last_seen_at > now() - interval '1 day'", (sid,))
    status = site_status(app, site, report, workers)
    return {
        "id": sid, "slug": site["slug"], "name": site["name"], "url": site["url"],
        "description": site["description"], "desired_state": site["desired_state"],
        "crash_restart": site["crash_restart"], "created_at": site["created_at"],
        **status,
        "host": report["host"] if report else {}, "process": report["script_process"] if report else {},
        "agent_version": report["agent_version"] if report else "",
    }


# -- commands -----------------------------------------------------------------

def issue_command(app, principal: Principal, site_ref: str, action: str, args: dict | None = None,
                  request=None) -> dict:
    args = args or {}
    if action in LIFECYCLE:
        permission, desired = LIFECYCLE[action]
    elif CUSTOM.match(action):
        permission, desired = "control:custom", None
    else:
        raise HTTPException(400, "Unknown command")
    db = app.state.db
    site = resolve_site(db, principal, site_ref, permission)
    sid = str(site["id"])
    if action == "set_workers":
        count = args.get("count")
        if type(count) is not int or not 0 <= count <= 1000:
            raise HTTPException(400, "Worker count must be an integer from 0 to 1000")
        args = {"count": count}
    if len(json.dumps(args)) > 16000:
        raise HTTPException(400, "Command arguments too large")
    with db.transaction() as cur:
        if action in ("start", "stop", "restart", "pause", "resume"):
            # Lifecycle commands express desired state; older unacknowledged
            # lifecycle commands are obsolete and must not replay later.
            cur.execute("UPDATE commands SET status='superseded', completed_at=now(), result='Superseded by newer command' "
                        "WHERE site_id=%s AND status IN ('pending','delivered') AND action IN ('start','stop','restart','pause','resume')",
                        (sid,))
        if desired:
            cur.execute("UPDATE sites SET desired_state=%s WHERE id=%s", (desired, sid))
        cur.execute(
            "INSERT INTO commands(site_id, action, args, requested_by, source) VALUES(%s,%s,%s::jsonb,%s,%s) RETURNING *",
            (sid, action, json.dumps(args), principal.user_id, principal.source))
        row = cur.fetchone()
    audit.record(db, principal, f"command.{action}", site_id=sid, target=str(row["id"]), detail=args, request=request)
    delivered = app.state.realtime.send_command(sid, {"command_id": str(row["id"]), "action": action, "args": args})
    if delivered:
        db.execute("UPDATE commands SET status='delivered', delivered_at=now() WHERE id=%s AND status='pending'", (row["id"],))
        row["status"] = "delivered"
    return command_view(row) | {"site_name": site["name"], "agent_online": delivered}


def command_view(row: dict) -> dict:
    return {"id": str(row["id"]), "site_id": str(row["site_id"]), "action": row["action"], "args": row["args"],
            "status": row["status"], "created_at": row["created_at"], "delivered_at": row.get("delivered_at"),
            "completed_at": row.get("completed_at"), "result": row.get("result"), "source": row.get("source")}


# -- statistics ---------------------------------------------------------------

PERIODS = {"1h": timedelta(hours=1), "24h": timedelta(days=1), "7d": timedelta(days=7),
           "30d": timedelta(days=30), "90d": timedelta(days=90), "365d": timedelta(days=365)}


def period(value: str | None) -> timedelta:
    if value in (None, ""):
        return PERIODS["24h"]
    if value not in PERIODS:
        raise HTTPException(400, f"Period must be one of {', '.join(PERIODS)}")
    return PERIODS[value]


def site_stats(app, site: dict, window: timedelta) -> dict:
    db = app.state.db
    sid = str(site["id"])
    since = now() - window
    logs = db.query("SELECT level, count(*) AS n FROM event_logs WHERE site_id=%s AND ts>=%s GROUP BY level", (sid, since))
    by_level = {r["level"]: r["n"] for r in logs}
    metrics = db.query(
        "SELECT name, kind, sum(value) AS total, avg(value) AS mean, max(value) AS peak, count(*) AS samples "
        "FROM metrics WHERE site_id=%s AND ts>=%s GROUP BY name, kind ORDER BY name", (sid, since))
    costs = db.query(
        "SELECT currency, sum(amount) AS total FROM cost_events WHERE site_id=%s AND ts>=%s GROUP BY currency", (sid, since))
    tasks = db.one("SELECT COALESCE(sum(tasks_completed), 0) AS total FROM workers WHERE site_id=%s", (sid,))
    return {
        "site_id": sid, "since": since,
        "logs": {"warnings": by_level.get(3, 0), "errors": by_level.get(4, 0) + by_level.get(5, 0),
                 "total": sum(by_level.values())},
        "metrics": [{"name": m["name"], "kind": m["kind"],
                     "value": float(m["total"]) if m["kind"] == "count" else float(m["mean"]),
                     "peak": float(m["peak"]), "samples": m["samples"]} for m in metrics],
        "costs": [{"currency": c["currency"], "total": float(c["total"])} for c in costs],
        "tasks_completed": int(tasks["total"]),
    }
