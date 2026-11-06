from __future__ import annotations

import secrets
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from .. import audit
from ..auth import require, sha256
from ..permissions import PERMISSIONS, ROLES, Principal
from ..security import hash_password

router = APIRouter(prefix="/api")


class UserCreate(BaseModel):
    username: str = Field(pattern=r"^[A-Za-z0-9_.-]{2,64}$")
    display_name: str = Field(default="", max_length=100)
    password: str = Field(min_length=12, max_length=1024)
    role: str
    extra_permissions: list[str] = Field(default_factory=list, max_length=len(PERMISSIONS))
    site_scope: list[str] | None = None


class UserPatch(BaseModel):
    display_name: str | None = Field(default=None, max_length=100)
    password: str | None = Field(default=None, min_length=12, max_length=1024)
    role: str | None = None
    extra_permissions: list[str] | None = None
    site_scope: list[str] | None = None
    clear_site_scope: bool = False
    disabled: bool | None = None


def _validate(db, role, extra, scope):
    if role is not None and role not in ROLES:
        raise HTTPException(400, f"Role must be one of {', '.join(ROLES)}")
    if extra is not None:
        unknown = set(extra) - set(PERMISSIONS)
        if unknown:
            raise HTTPException(400, f"Unknown permissions: {', '.join(sorted(unknown))}")
    if scope:
        found = {str(r["id"]) for r in db.query("SELECT id FROM sites WHERE id = ANY(%s::uuid[])", (scope,))}
        if found != set(scope):
            raise HTTPException(400, "Site scope contains unknown sites")


@router.get("/users")
def list_users(request: Request, principal: Principal = Depends(require("users:manage"))):
    auth = request.app.state.auth
    return [auth.user_view(r) for r in request.app.state.db.query("SELECT * FROM users ORDER BY created_at")]


@router.post("/users", status_code=201)
def create_user(body: UserCreate, request: Request, principal: Principal = Depends(require("users:manage"))):
    db = request.app.state.db
    _validate(db, body.role, body.extra_permissions, body.site_scope)
    if body.role == "owner" and principal.role != "owner":
        raise HTTPException(403, "Only an owner can create another owner")
    if db.one("SELECT 1 AS x FROM users WHERE username=%s", (body.username.lower(),)):
        raise HTTPException(409, "Username already exists")
    row = db.one(
        "INSERT INTO users(username, display_name, password_hash, role, permissions, site_scope, created_by) "
        "VALUES(%s,%s,%s,%s,%s,%s,%s) RETURNING *",
        (body.username.lower(), body.display_name, hash_password(body.password), body.role,
         body.extra_permissions, body.site_scope or None, principal.user_id))
    audit.record(db, principal, "user.create", target=row["username"],
                 detail={"role": body.role, "extra": body.extra_permissions, "scope": body.site_scope}, request=request)
    return request.app.state.auth.user_view(row)


@router.patch("/users/{user_id}")
def update_user(user_id: str, body: UserPatch, request: Request, principal: Principal = Depends(require("users:manage"))):
    db = request.app.state.db
    row = db.one("SELECT * FROM users WHERE id=%s", (user_id,))
    if not row:
        raise HTTPException(404, "User not found")
    _validate(db, body.role, body.extra_permissions, body.site_scope)
    if (row["role"] == "owner" or body.role == "owner") and principal.role != "owner":
        raise HTTPException(403, "Only an owner can change owners")
    if str(row["id"]) == principal.user_id and (body.disabled or (body.role and body.role != row["role"])):
        raise HTTPException(400, "You cannot disable yourself or change your own role")
    if row["role"] == "owner" and (body.disabled or (body.role and body.role != "owner")):
        owners = db.one("SELECT count(*) AS n FROM users WHERE role='owner' AND disabled=false")["n"]
        if owners <= 1:
            raise HTTPException(400, "At least one active owner is required")
    updates, params, changed = [], [], {}
    for field, column in (("display_name", "display_name"), ("role", "role"),
                          ("extra_permissions", "permissions"), ("disabled", "disabled")):
        value = getattr(body, field)
        if value is not None:
            updates.append(f"{column}=%s")
            params.append(value)
            changed[field] = value
    if body.clear_site_scope:
        updates.append("site_scope=NULL")
        changed["site_scope"] = None
    elif body.site_scope is not None:
        updates.append("site_scope=%s")
        params.append(body.site_scope)
        changed["site_scope"] = body.site_scope
    if body.password:
        updates += ["password_hash=%s", "password_changed_at=now()"]
        params.append(hash_password(body.password))
        changed["password"] = "changed"
    if not updates:
        return request.app.state.auth.user_view(row)
    with db.transaction() as cur:
        cur.execute(f"UPDATE users SET {', '.join(updates)} WHERE id=%s RETURNING *", (*params, user_id))
        row = cur.fetchone()
        if body.password or body.disabled or body.role:
            cur.execute("UPDATE sessions SET revoked_at=now() WHERE user_id=%s AND revoked_at IS NULL", (user_id,))
    audit.record(db, principal, "user.update", target=row["username"], detail=changed, request=request)
    return request.app.state.auth.user_view(row)


# -- bot account linking --------------------------------------------------------

@router.post("/me/bot-link-code")
def bot_link_code(request: Request, principal: Principal = Depends(require("sites:view"))):
    """One-time code the user sends to the Discord/Telegram bot: `/link <code>`."""
    code = "-".join(secrets.token_hex(2).upper() for _ in range(3))
    db = request.app.state.db
    db.execute("DELETE FROM bot_link_codes WHERE user_id=%s OR expires_at<now()", (principal.user_id,))
    db.execute("INSERT INTO bot_link_codes(code_hash, user_id, expires_at) VALUES(%s,%s,%s)",
               (sha256(code), principal.user_id, datetime.now(timezone.utc) + timedelta(minutes=10)))
    audit.record(db, principal, "bot.link_code", request=request)
    return {"code": code, "expires_in": 600}


@router.get("/me/bot-links")
def my_bot_links(request: Request, principal: Principal = Depends(require("sites:view"))):
    return request.app.state.db.query(
        "SELECT platform, platform_user, created_at FROM bot_links WHERE user_id=%s ORDER BY created_at", (principal.user_id,))


@router.delete("/me/bot-links/{platform}/{platform_user}")
def unlink_bot(platform: str, platform_user: str, request: Request, principal: Principal = Depends(require("sites:view"))):
    db = request.app.state.db
    count = db.execute("DELETE FROM bot_links WHERE platform=%s AND platform_user=%s AND user_id=%s",
                       (platform, platform_user, principal.user_id))
    if not count:
        raise HTTPException(404, "Link not found")
    audit.record(db, principal, "bot.unlink", target=f"{platform}:{platform_user}", request=request)
    return {"ok": True}


@router.get("/bot-links")
def all_bot_links(request: Request, principal: Principal = Depends(require("bots:manage"))):
    rows = request.app.state.db.query(
        "SELECT b.platform, b.platform_user, b.created_at, u.username FROM bot_links b JOIN users u ON u.id=b.user_id ORDER BY b.created_at")
    return rows


@router.post("/service-tokens/bot", status_code=201)
def create_bot_token(request: Request, principal: Principal = Depends(require("bots:manage"))):
    token = "hbt_" + secrets.token_urlsafe(40)
    db = request.app.state.db
    row = db.one("INSERT INTO service_tokens(kind, label, token_hash, created_by) VALUES('bot', 'BambouBot', %s, %s) RETURNING id",
                 (sha256(token), principal.user_id))
    audit.record(db, principal, "bot.token_create", target=str(row["id"]), request=request)
    return {"id": str(row["id"]), "token": token}


@router.get("/service-tokens")
def list_service_tokens(request: Request, principal: Principal = Depends(require("bots:manage"))):
    rows = request.app.state.db.query(
        "SELECT id, kind, label, created_at, revoked_at, last_used_at FROM service_tokens ORDER BY created_at DESC")
    return [{**r, "id": str(r["id"])} for r in rows]


@router.delete("/service-tokens/{token_id}")
def revoke_service_token(token_id: str, request: Request, principal: Principal = Depends(require("bots:manage"))):
    db = request.app.state.db
    if not db.execute("UPDATE service_tokens SET revoked_at=now() WHERE id=%s AND revoked_at IS NULL", (token_id,)):
        raise HTTPException(404, "Token not found")
    audit.record(db, principal, "bot.token_revoke", target=token_id, request=request)
    return {"ok": True}
