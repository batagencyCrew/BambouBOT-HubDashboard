"""Endpoints only the bot service calls (service token), plus alert delivery.

Normal hub operations from the bot (sites, start, logs, ...) use the regular
/api routes with the bot token + ``X-Bot-User`` header, so the linked hub user's
permissions apply exactly as on the dashboard.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from .. import audit
from ..auth import sha256

router = APIRouter(prefix="/api/bot")


def service(request: Request) -> str:
    return request.app.state.auth.bot_service(request)


class Link(BaseModel):
    platform: str = Field(pattern="^(discord|telegram)$")
    platform_user: str = Field(min_length=1, max_length=64)
    code: str = Field(min_length=4, max_length=40)


@router.post("/link")
def link(body: Link, request: Request):
    service(request)
    db = request.app.state.db
    code = body.code.strip().upper()
    row = db.one("DELETE FROM bot_link_codes WHERE code_hash=%s AND expires_at > now() RETURNING user_id", (sha256(code),))
    if not row:
        raise HTTPException(400, "Invalid or expired link code")
    db.execute("INSERT INTO bot_links(platform, platform_user, user_id) VALUES(%s,%s,%s) "
               "ON CONFLICT (platform, platform_user) DO UPDATE SET user_id=excluded.user_id, created_at=now()",
               (body.platform, body.platform_user, row["user_id"]))
    user = db.one("SELECT * FROM users WHERE id=%s", (row["user_id"],))
    principal = request.app.state.auth._principal(user, source="bot", bot_platform=body.platform, bot_user=body.platform_user)
    audit.record(db, principal, "bot.link", target=f"{body.platform}:{body.platform_user}", request=request)
    return {"user": request.app.state.auth.user_view(user)}


class Identity(BaseModel):
    platform: str = Field(pattern="^(discord|telegram)$")
    platform_user: str = Field(min_length=1, max_length=64)


@router.post("/identity")
def identity(body: Identity, request: Request):
    service(request)
    db = request.app.state.db
    row = db.one("SELECT u.* FROM bot_links b JOIN users u ON u.id=b.user_id WHERE b.platform=%s AND b.platform_user=%s",
                 (body.platform, body.platform_user))
    if not row or row["disabled"]:
        return {"linked": False}
    return {"linked": True, "user": request.app.state.auth.user_view(row)}


@router.post("/unlink")
def unlink(body: Identity, request: Request):
    service(request)
    db = request.app.state.db
    db.execute("DELETE FROM bot_links WHERE platform=%s AND platform_user=%s", (body.platform, body.platform_user))
    return {"ok": True}


@router.get("/deliveries")
def deliveries(request: Request, limit: int = 50):
    """Pending alert notifications. The bot sends them and reports back."""
    service(request)
    db = request.app.state.db
    rows = db.query(
        "SELECT d.id, d.platform, d.channel, d.attempts, a.id AS alert_id, a.severity, a.title, a.body, a.status, "
        "a.opened_at, a.resolved_at, s.name AS site_name, s.slug AS site_slug FROM alert_deliveries d "
        "JOIN alerts a ON a.id=d.alert_id LEFT JOIN sites s ON s.id=a.site_id "
        "WHERE d.status='pending' AND d.attempts < 10 ORDER BY d.created_at LIMIT %s", (min(max(limit, 1), 200),))
    return [{**r, "alert_id": str(r["alert_id"])} for r in rows]


class DeliveryResult(BaseModel):
    ok: bool
    error: str | None = Field(default=None, max_length=500)


@router.post("/deliveries/{delivery_id}")
def delivery_result(delivery_id: int, body: DeliveryResult, request: Request):
    service(request)
    db = request.app.state.db
    if body.ok:
        db.execute("UPDATE alert_deliveries SET status='sent', sent_at=now(), attempts=attempts+1 WHERE id=%s", (delivery_id,))
    else:
        db.execute("UPDATE alert_deliveries SET attempts=attempts+1, error=%s, "
                   "status=CASE WHEN attempts+1 >= 10 THEN 'failed' ELSE 'pending' END WHERE id=%s", (body.error, delivery_id))
    return {"ok": True}
