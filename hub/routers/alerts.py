from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field

from .. import alerts, audit, services
from ..auth import require
from ..permissions import Principal

router = APIRouter(prefix="/api/alerts")


class Channel(BaseModel):
    platform: str = Field(pattern="^(discord|telegram)$")
    chat_id: str = Field(min_length=1, max_length=64)


class RuleBody(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    kind: str
    site_id: str | None = None
    params: dict = Field(default_factory=dict)
    severity: str = Field(default="warning", pattern="^(info|warning|critical)$")
    enabled: bool = True
    channels: list[Channel] = Field(default_factory=list, max_length=20)
    cooldown_seconds: int = Field(default=900, ge=0, le=86400)


@router.get("")
def list_alerts(request: Request, status: str = "active", site: str | None = None,
                limit: int = Query(default=100, ge=1, le=1000), principal: Principal = Depends(require("sites:view"))):
    db = request.app.state.db
    clauses, params = [], []
    if status == "active":
        clauses.append("a.status IN ('open','acknowledged','muted')")
    elif status != "all":
        clauses.append("a.status=%s")
        params.append(status)
    if site:
        row = services.resolve_site(db, principal, site)
        clauses.append("a.site_id=%s")
        params.append(row["id"])
    where = ("WHERE " + " AND ".join(clauses)) if clauses else ""
    rows = db.query(f"SELECT a.*, s.name AS site_name, u.username AS ack_by_name FROM alerts a LEFT JOIN sites s ON s.id=a.site_id "
                    f"LEFT JOIN users u ON u.id=a.ack_by {where} ORDER BY a.opened_at DESC LIMIT %s", (*params, limit))
    return [alerts.alert_view(r, r["site_name"] or "") | {"ack_by": r["ack_by_name"]}
            for r in rows if r["site_id"] is None or principal.visible_site(str(r["site_id"]))]


def _alert(db, principal, alert_id):
    row = db.one("SELECT * FROM alerts WHERE id=%s", (alert_id,))
    if not row or (row["site_id"] and not principal.visible_site(str(row["site_id"]))):
        raise HTTPException(404, "Alert not found")
    return row


class Mute(BaseModel):
    minutes: int = Field(default=60, ge=1, le=60 * 24 * 30)


@router.post("/{alert_id}/ack")
def ack(alert_id: str, request: Request, principal: Principal = Depends(require("alerts:ack"))):
    db = request.app.state.db
    row = _alert(db, principal, alert_id)
    db.execute("UPDATE alerts SET status='acknowledged', ack_by=%s, ack_at=now(), updated_at=now() WHERE id=%s AND status='open'",
               (principal.user_id, row["id"]))
    audit.record(db, principal, "alert.ack", site_id=str(row["site_id"]) if row["site_id"] else None, target=row["title"], request=request)
    request.app.state.realtime.publish({"type": "alert", "event": "acknowledged", "alert": alerts.alert_view(
        db.one("SELECT * FROM alerts WHERE id=%s", (row["id"],)), alerts.site_name(db, row["site_id"])), "by": principal.username})
    return {"ok": True}


@router.post("/{alert_id}/mute")
def mute(alert_id: str, body: Mute, request: Request, principal: Principal = Depends(require("alerts:ack"))):
    db = request.app.state.db
    row = _alert(db, principal, alert_id)
    until = datetime.now(timezone.utc) + timedelta(minutes=body.minutes)
    db.execute("UPDATE alerts SET status='muted', muted_until=%s, updated_at=now() WHERE id=%s", (until, row["id"]))
    audit.record(db, principal, "alert.mute", site_id=str(row["site_id"]) if row["site_id"] else None, target=row["title"],
                 detail={"minutes": body.minutes}, request=request)
    return {"ok": True, "muted_until": until}


@router.post("/{alert_id}/resolve")
def resolve(alert_id: str, request: Request, principal: Principal = Depends(require("alerts:ack"))):
    db = request.app.state.db
    row = _alert(db, principal, alert_id)
    alerts.resolve(request.app, row["dedup_key"], f"Resolved by {principal.username}")
    db.execute("UPDATE alerts SET status='resolved', resolved_at=COALESCE(resolved_at, now()) WHERE id=%s", (row["id"],))
    audit.record(db, principal, "alert.resolve", site_id=str(row["site_id"]) if row["site_id"] else None, target=row["title"], request=request)
    return {"ok": True}


# -- rules -----------------------------------------------------------------------

@router.get("/rules")
def rules(request: Request, principal: Principal = Depends(require("sites:view"))):
    rows = request.app.state.db.query("SELECT * FROM alert_rules ORDER BY created_at")
    return {"kinds": alerts.RULE_KINDS,
            "rules": [{**r, "id": str(r["id"]), "site_id": str(r["site_id"]) if r["site_id"] else None} for r in rows]}


def _check_rule(db, principal, body: RuleBody):
    if body.kind not in alerts.RULE_KINDS:
        raise HTTPException(400, "Unknown rule kind")
    if body.site_id:
        services.resolve_site(db, principal, body.site_id)


@router.post("/rules", status_code=201)
def create_rule(body: RuleBody, request: Request, principal: Principal = Depends(require("alerts:manage"))):
    db = request.app.state.db
    _check_rule(db, principal, body)
    row = db.one("INSERT INTO alert_rules(site_id, name, kind, params, severity, enabled, channels, cooldown_seconds) "
                 "VALUES(%s,%s,%s,%s::jsonb,%s,%s,%s::jsonb,%s) RETURNING *",
                 (body.site_id, body.name, body.kind, json.dumps(body.params), body.severity, body.enabled,
                  json.dumps([c.model_dump() for c in body.channels]), body.cooldown_seconds))
    audit.record(db, principal, "alert_rule.create", target=body.name, detail=body.model_dump(), request=request)
    return {**row, "id": str(row["id"])}


@router.put("/rules/{rule_id}")
def update_rule(rule_id: str, body: RuleBody, request: Request, principal: Principal = Depends(require("alerts:manage"))):
    db = request.app.state.db
    _check_rule(db, principal, body)
    row = db.one("UPDATE alert_rules SET site_id=%s, name=%s, kind=%s, params=%s::jsonb, severity=%s, enabled=%s, "
                 "channels=%s::jsonb, cooldown_seconds=%s, updated_at=now() WHERE id=%s RETURNING *",
                 (body.site_id, body.name, body.kind, json.dumps(body.params), body.severity, body.enabled,
                  json.dumps([c.model_dump() for c in body.channels]), body.cooldown_seconds, rule_id))
    if not row:
        raise HTTPException(404, "Rule not found")
    audit.record(db, principal, "alert_rule.update", target=body.name, detail=body.model_dump(), request=request)
    return {**row, "id": str(row["id"])}


@router.delete("/rules/{rule_id}")
def delete_rule(rule_id: str, request: Request, principal: Principal = Depends(require("alerts:manage"))):
    db = request.app.state.db
    row = db.one("DELETE FROM alert_rules WHERE id=%s RETURNING name", (rule_id,))
    if not row:
        raise HTTPException(404, "Rule not found")
    audit.record(db, principal, "alert_rule.delete", target=row["name"], request=request)
    return {"ok": True}


@router.get("/channels")
def get_channels(request: Request, principal: Principal = Depends(require("sites:view"))):
    return alerts.default_channels(request.app.state.db)


@router.put("/channels")
def set_channels(body: list[Channel], request: Request, principal: Principal = Depends(require("alerts:manage"))):
    db = request.app.state.db
    value = json.dumps([c.model_dump() for c in body])
    db.execute("INSERT INTO hub_settings(key, value, updated_by) VALUES('alert_channels', %s::jsonb, %s) "
               "ON CONFLICT (key) DO UPDATE SET value=excluded.value, updated_by=excluded.updated_by, updated_at=now()",
               (value, principal.user_id))
    audit.record(db, principal, "alert.channels", detail={"channels": [c.model_dump() for c in body]}, request=request)
    return {"ok": True}
