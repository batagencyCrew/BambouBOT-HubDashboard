from __future__ import annotations

import re
import uuid

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field, field_validator

from .. import audit, services
from ..auth import require
from ..permissions import Principal

router = APIRouter(prefix="/api/sites")


def slugify(name: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:63].strip("-")
    return slug or "site"


class SiteCreate(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    slug: str | None = Field(default=None, pattern=r"^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$")
    url: str = Field(default="", max_length=2048)
    description: str = Field(default="", max_length=4000)

    @field_validator("url")
    @classmethod
    def http_url(cls, value):
        if value and not re.match(r"^https?://[^\s/$.?#].[^\s]*$", value):
            raise ValueError("URL must start with http:// or https://")
        return value


class SitePatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    url: str | None = Field(default=None, max_length=2048)
    description: str | None = Field(default=None, max_length=4000)
    crash_restart: bool | None = None


class CommandBody(BaseModel):
    action: str = Field(max_length=80)
    args: dict = Field(default_factory=dict)


@router.get("")
def list_sites(request: Request, principal: Principal = Depends(require("sites:view"))):
    return [services.site_summary(request.app, s) for s in services.visible_sites(request.app.state.db, principal)]


@router.post("", status_code=201)
def create_site(body: SiteCreate, request: Request, principal: Principal = Depends(require("sites:create"))):
    db = request.app.state.db
    slug = body.slug or slugify(body.name)
    base, n = slug, 2
    while db.one("SELECT 1 AS x FROM sites WHERE slug=%s", (slug,)):
        if body.slug:
            raise HTTPException(409, "Slug already in use")
        slug = f"{base[:60]}-{n}"
        n += 1
    with db.transaction() as cur:
        cur.execute("INSERT INTO sites(slug, name, url, description) VALUES(%s,%s,%s,%s) RETURNING *",
                    (slug, body.name.strip(), body.url, body.description))
        site = cur.fetchone()
        cur.execute("INSERT INTO site_backup_config(site_id) VALUES(%s)", (site["id"],))
    token = request.app.state.auth.issue_site_token(str(site["id"]), "initial", principal.user_id)
    audit.record(db, principal, "site.create", site_id=str(site["id"]), target=site["name"], request=request)
    return {"site": services.site_summary(request.app, site), "agent_token": token}


@router.get("/{site_ref}")
def get_site(site_ref: str, request: Request, principal: Principal = Depends(require("sites:view"))):
    site = services.resolve_site(request.app.state.db, principal, site_ref)
    summary = services.site_summary(request.app, site)
    caps = request.app.state.db.one("SELECT commands, files, sdk FROM site_capabilities WHERE site_id=%s", (site["id"],))
    summary["capabilities"] = caps or {"commands": [], "files": [], "sdk": ""}
    return summary


@router.patch("/{site_ref}")
def update_site(site_ref: str, body: SitePatch, request: Request, principal: Principal = Depends(require("sites:edit"))):
    db = request.app.state.db
    site = services.resolve_site(db, principal, site_ref, "sites:edit")
    values = body.model_dump(exclude_none=True)
    if "url" in values and values["url"] and not re.match(r"^https?://", values["url"]):
        raise HTTPException(400, "URL must start with http:// or https://")
    if not values:
        return services.site_summary(request.app, site)
    sets = ", ".join(f"{k}=%s" for k in values)
    row = db.one(f"UPDATE sites SET {sets} WHERE id=%s RETURNING *", (*values.values(), site["id"]))
    audit.record(db, principal, "site.update", site_id=str(site["id"]), detail=values, request=request)
    return services.site_summary(request.app, row)


@router.delete("/{site_ref}")
def delete_site(site_ref: str, request: Request, confirm: str = Query(default=""),
                principal: Principal = Depends(require("sites:delete"))):
    db = request.app.state.db
    site = services.resolve_site(db, principal, site_ref, "sites:delete")
    if confirm != site["slug"]:
        raise HTTPException(400, "Pass ?confirm=<slug> to delete a site and all its data")
    sid = str(site["id"])
    audit.record(db, principal, "site.delete", site_id=None, target=f"{site['name']} ({sid})", request=request)
    with db.transaction() as cur:
        for table in ("event_logs", "worker_samples", "metrics", "cost_events"):
            cur.execute(f"DELETE FROM {table} WHERE site_id=%s", (sid,))
        cur.execute("DELETE FROM sites WHERE id=%s", (sid,))
    return {"ok": True}


# -- agent tokens -------------------------------------------------------------

@router.get("/{site_ref}/tokens")
def tokens(site_ref: str, request: Request, principal: Principal = Depends(require("sites:create"))):
    db = request.app.state.db
    site = services.resolve_site(db, principal, site_ref, "sites:create")
    rows = db.query("SELECT id, label, created_at, revoked_at, last_used_at FROM site_tokens WHERE site_id=%s ORDER BY created_at DESC",
                    (site["id"],))
    return [{**r, "id": str(r["id"])} for r in rows]


@router.post("/{site_ref}/tokens", status_code=201)
def rotate_token(site_ref: str, request: Request, revoke_existing: bool = True,
                 principal: Principal = Depends(require("sites:create"))):
    db = request.app.state.db
    site = services.resolve_site(db, principal, site_ref, "sites:create")
    if revoke_existing:
        db.execute("UPDATE site_tokens SET revoked_at=now() WHERE site_id=%s AND revoked_at IS NULL", (site["id"],))
    token = request.app.state.auth.issue_site_token(str(site["id"]), "rotated", principal.user_id)
    audit.record(db, principal, "site.token_rotate", site_id=str(site["id"]), detail={"revoked_existing": revoke_existing},
                 request=request)
    return {"agent_token": token}


# -- workers ------------------------------------------------------------------

@router.get("/{site_ref}/workers")
def workers(site_ref: str, request: Request, include_stale: bool = False,
            principal: Principal = Depends(require("sites:view"))):
    db = request.app.state.db
    site = services.resolve_site(db, principal, site_ref)
    clause = "" if include_stale else " AND last_seen_at > now() - interval '1 day'"
    rows = db.query(f"SELECT * FROM workers WHERE site_id=%s{clause} ORDER BY name", (site["id"],))
    return [{**r, "id": str(r["id"]), "site_id": str(r["site_id"])} for r in rows]


@router.get("/{site_ref}/workers/{worker_id}/samples")
def worker_samples(site_ref: str, worker_id: str, request: Request, period: str = "24h",
                   principal: Principal = Depends(require("sites:view"))):
    db = request.app.state.db
    site = services.resolve_site(db, principal, site_ref)
    try:
        worker_id = str(uuid.UUID(worker_id))
    except ValueError:
        raise HTTPException(404, "Worker not found") from None
    window = services.period(period)
    bucket = "1 minute" if window.total_seconds() <= 86400 else "1 hour"
    return db.query(
        f"SELECT date_bin(interval '{bucket}', ts, timestamptz '2000-01-01') AS bucket, avg(cpu_percent) AS cpu, "
        "avg(memory_mb) AS memory, max(tasks_completed) AS tasks, mode() WITHIN GROUP (ORDER BY status) AS status "
        "FROM worker_samples WHERE site_id=%s AND worker_id=%s AND ts >= now() - %s GROUP BY 1 ORDER BY 1",
        (site["id"], worker_id, window))


# -- commands -----------------------------------------------------------------

@router.post("/{site_ref}/commands", status_code=201)
def send_command(site_ref: str, body: CommandBody, request: Request,
                 principal: Principal = Depends(require("sites:view"))):
    return services.issue_command(request.app, principal, site_ref, body.action, body.args, request)


@router.get("/{site_ref}/commands")
def list_commands(site_ref: str, request: Request, limit: int = Query(default=50, ge=1, le=500),
                  principal: Principal = Depends(require("sites:view"))):
    db = request.app.state.db
    site = services.resolve_site(db, principal, site_ref)
    rows = db.query(
        "SELECT c.*, u.username FROM commands c LEFT JOIN users u ON u.id=c.requested_by "
        "WHERE c.site_id=%s ORDER BY c.created_at DESC LIMIT %s", (site["id"], limit))
    return [services.command_view(r) | {"requested_by": r["username"]} for r in rows]


@router.get("/{site_ref}/stats")
def stats(site_ref: str, request: Request, period: str = "24h", principal: Principal = Depends(require("sites:view"))):
    site = services.resolve_site(request.app.state.db, principal, site_ref)
    return services.site_stats(request.app, site, services.period(period))
