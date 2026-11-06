from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query, Request

from .. import services
from ..auth import require
from ..ingest import LEVELS
from ..permissions import Principal

router = APIRouter(prefix="/api")
LEVEL_NAMES = {v: k for k, v in LEVELS.items()}


def _log_view(row):
    return {"id": row["id"], "site_id": str(row["site_id"]), "worker_id": str(row["worker_id"]) if row["worker_id"] else None,
            "worker_name": row["worker_name"], "ts": row["ts"], "level": LEVEL_NAMES.get(row["level"], "info"),
            "source": row["source"], "message": row["message"], "context": row["context"], "exception": row["exception"]}


@router.get("/logs")
def logs(request: Request,
         site: str | None = None,
         worker: str | None = None,
         level: str = "debug",
         q: str | None = Query(default=None, max_length=200),
         before_id: int | None = None,
         since: datetime | None = None,
         until: datetime | None = None,
         limit: int = Query(default=100, ge=1, le=1000),
         principal: Principal = Depends(require("sites:view"))):
    """Keyset-paginated log search across all visible sites or one site."""
    db = request.app.state.db
    clauses, params = [], []
    if site:
        row = services.resolve_site(db, principal, site)
        clauses.append("site_id=%s")
        params.append(row["id"])
    elif principal.site_scope is not None:
        clauses.append("site_id = ANY(%s::uuid[])")
        params.append(list(principal.site_scope))
    if worker:
        clauses.append("(worker_id::text=%s OR worker_name=%s)")
        params += [worker, worker]
    if level not in LEVELS:
        raise HTTPException(400, "Unknown level")
    if LEVELS[level] > 0:
        clauses.append("level >= %s")
        params.append(LEVELS[level])
    if q:
        clauses.append("message ILIKE %s")
        params.append("%" + q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%")
    if before_id:
        clauses.append("id < %s")
        params.append(before_id)
    if since:
        clauses.append("ts >= %s")
        params.append(since)
    if until:
        clauses.append("ts <= %s")
        params.append(until)
    where = ("WHERE " + " AND ".join(clauses)) if clauses else ""
    rows = db.query(f"SELECT * FROM event_logs {where} ORDER BY id DESC LIMIT %s", (*params, limit))
    names = {str(s["id"]): s["name"] for s in db.query("SELECT id, name FROM sites")}
    items = [_log_view(r) | {"site_name": names.get(str(r["site_id"]), "")} for r in rows]
    return {"items": items, "next_before_id": rows[-1]["id"] if len(rows) == limit else None}


@router.get("/sites/{site_ref}/metrics")
def metric_names(site_ref: str, request: Request, period: str = "7d", principal: Principal = Depends(require("sites:view"))):
    db = request.app.state.db
    site = services.resolve_site(db, principal, site_ref)
    return db.query("SELECT name, kind, count(*) AS samples, max(ts) AS last_ts FROM metrics "
                    "WHERE site_id=%s AND ts >= now() - %s GROUP BY name, kind ORDER BY name",
                    (site["id"], services.period(period)))


@router.get("/sites/{site_ref}/metrics/{name}")
def metric_series(site_ref: str, name: str, request: Request, period: str = "24h",
                  worker: str | None = None, principal: Principal = Depends(require("sites:view"))):
    db = request.app.state.db
    site = services.resolve_site(db, principal, site_ref)
    window = services.period(period)
    seconds = window.total_seconds()
    bucket = "1 minute" if seconds <= 3600 else "10 minutes" if seconds <= 86400 else "1 hour" if seconds <= 7 * 86400 else "1 day"
    params = [site["id"], name, window]
    worker_clause = ""
    if worker:
        worker_clause = " AND worker_id::text=%s"
        params.append(worker)
    kind = db.one("SELECT kind FROM metrics WHERE site_id=%s AND name=%s LIMIT 1", (site["id"], name))
    agg = "sum(value)" if kind and kind["kind"] == "count" else "avg(value)"
    rows = db.query(
        f"SELECT date_bin(interval '{bucket}', ts, timestamptz '2000-01-01') AS bucket, {agg} AS value, count(*) AS samples "
        f"FROM metrics WHERE site_id=%s AND name=%s AND ts >= now() - %s{worker_clause} GROUP BY 1 ORDER BY 1", params)
    return {"name": name, "kind": kind["kind"] if kind else None, "bucket": bucket,
            "points": [{"ts": r["bucket"], "value": float(r["value"]), "samples": r["samples"]} for r in rows]}


@router.get("/costs")
def costs(request: Request, site: str | None = None, period: str = "30d",
          group_by: str = Query(default="day", pattern="^(day|provider|category|site|worker)$"),
          principal: Principal = Depends(require("sites:view"))):
    db = request.app.state.db
    params: list = [services.period(period)]
    clause = ""
    if site:
        row = services.resolve_site(db, principal, site)
        clause = " AND c.site_id=%s"
        params.append(row["id"])
    elif principal.site_scope is not None:
        clause = " AND c.site_id = ANY(%s::uuid[])"
        params.append(list(principal.site_scope))
    key = {"day": "date_trunc('day', c.ts)", "provider": "c.provider", "category": "c.category",
           "site": "s.name", "worker": "COALESCE(w.name, 'script')"}[group_by]
    rows = db.query(
        f"SELECT {key} AS key, c.currency, sum(c.amount) AS total, count(*) AS events, sum(c.quantity) AS quantity "
        "FROM cost_events c JOIN sites s ON s.id=c.site_id LEFT JOIN workers w ON w.id=c.worker_id "
        f"WHERE c.ts >= now() - %s{clause} GROUP BY 1, 2 ORDER BY 1", params)
    totals: dict[str, float] = {}
    for r in rows:
        totals[r["currency"]] = totals.get(r["currency"], 0) + float(r["total"])
    return {"group_by": group_by, "rows": [{"key": r["key"], "currency": r["currency"], "total": float(r["total"]),
                                            "events": r["events"], "quantity": float(r["quantity"]) if r["quantity"] is not None else None}
                                           for r in rows],
            "totals": totals}


@router.get("/costs/events")
def cost_events(request: Request, site: str, limit: int = Query(default=200, ge=1, le=2000),
                principal: Principal = Depends(require("sites:view"))):
    db = request.app.state.db
    row = services.resolve_site(db, principal, site)
    rows = db.query("SELECT ts, category, provider, amount, currency, quantity, unit, worker_id, meta FROM cost_events "
                    "WHERE site_id=%s ORDER BY ts DESC LIMIT %s", (row["id"], limit))
    return [{**r, "amount": float(r["amount"]), "quantity": float(r["quantity"]) if r["quantity"] is not None else None,
             "worker_id": str(r["worker_id"]) if r["worker_id"] else None} for r in rows]


@router.get("/balances")
def balances(request: Request, site: str | None = None, principal: Principal = Depends(require("sites:view"))):
    db = request.app.state.db
    params, clause = [], ""
    if site:
        row = services.resolve_site(db, principal, site)
        clause, params = " WHERE b.site_id=%s", [row["id"]]
    rows = db.query("SELECT b.*, s.name AS site_name FROM account_balances b JOIN sites s ON s.id=b.site_id"
                    f"{clause} ORDER BY s.name, b.provider", params)
    return [{"site_id": str(r["site_id"]), "site_name": r["site_name"], "provider": r["provider"], "label": r["label"],
             "currency": r["currency"], "balance": float(r["balance"]),
             "low_threshold": float(r["low_threshold"]) if r["low_threshold"] is not None else None,
             "low": r["low_threshold"] is not None and r["balance"] <= r["low_threshold"], "reported_at": r["reported_at"]}
            for r in rows if principal.visible_site(str(r["site_id"]))]


@router.get("/sites/{site_ref}/proxy-health")
def proxy_health(site_ref: str, request: Request, period: str = "24h",
                 principal: Principal = Depends(require("sites:view"))):
    db = request.app.state.db
    site = services.resolve_site(db, principal, site_ref)
    rows = db.query(
        "SELECT proxy_key, max(label) AS label, count(*) AS observations, "
        "count(*) FILTER (WHERE state='ok') AS ok, count(*) FILTER (WHERE state='slow') AS slow, "
        "count(*) FILTER (WHERE state='blocked') AS blocked, count(*) FILTER (WHERE state='auth') AS auth, "
        "count(*) FILTER (WHERE state='timeout') AS timeout, max(ts) AS last_ts, "
        "(array_agg(state ORDER BY ts DESC))[1] AS last_state, (array_agg(detail ORDER BY ts DESC))[1] AS last_detail "
        "FROM proxy_observations WHERE site_id=%s AND ts >= now() - %s GROUP BY proxy_key ORDER BY label, proxy_key",
        (site["id"], services.period(period)))
    out = []
    for r in rows:
        bad = r["blocked"] + r["auth"] + r["timeout"]
        rate = (r["ok"] + r["slow"]) / r["observations"] if r["observations"] else None
        out.append({**r, "success_rate": rate, "failures": bad,
                    "health": "healthy" if r["last_state"] in ("ok",) else "degraded" if r["last_state"] == "slow" else "failing"})
    return out
