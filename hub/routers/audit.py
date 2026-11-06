from __future__ import annotations

from fastapi import APIRouter, Depends, Query, Request

from .. import services
from ..auth import require
from ..permissions import Principal

router = APIRouter(prefix="/api/audit")


@router.get("")
def audit_log(request: Request, site: str | None = None, actor: str | None = None, action: str | None = None,
              before_id: int | None = None, limit: int = Query(default=100, ge=1, le=1000),
              principal: Principal = Depends(require("users:audit"))):
    db = request.app.state.db
    clauses, params = [], []
    if site:
        clauses.append("a.site_id=%s")
        params.append(services.resolve_site(db, principal, site)["id"])
    if actor:
        clauses.append("a.actor=%s")
        params.append(actor.lower())
    if action:
        clauses.append("a.action LIKE %s")
        params.append(action.replace("%", "") + "%")
    if before_id:
        clauses.append("a.id < %s")
        params.append(before_id)
    where = ("WHERE " + " AND ".join(clauses)) if clauses else ""
    rows = db.query(f"SELECT a.*, s.name AS site_name FROM audit_log a LEFT JOIN sites s ON s.id=a.site_id {where} "
                    "ORDER BY a.id DESC LIMIT %s", (*params, limit))
    return {"items": [{**r, "user_id": str(r["user_id"]) if r["user_id"] else None,
                       "site_id": str(r["site_id"]) if r["site_id"] else None} for r in rows],
            "next_before_id": rows[-1]["id"] if len(rows) == limit else None}
