from __future__ import annotations

import threading
import time
from collections import OrderedDict, deque

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, Field

from .. import audit
from ..auth import require
from ..permissions import PERMISSIONS, ROLE_DEFAULTS, Principal
from ..security import hash_password, verify_password

router = APIRouter(prefix="/api/auth")

class Throttle:
    """Per-process login limiter, kept on app.state so each app instance is isolated."""

    def __init__(self):
        self.attempts: OrderedDict[str, deque] = OrderedDict()
        self.lock = threading.Lock()


def _throttle(request: Request, key: str, limit: int = 10, window: int = 300):
    state = request.app.state
    if not hasattr(state, "login_throttle"):
        state.login_throttle = Throttle()
    _attempts, _lock = state.login_throttle.attempts, state.login_throttle.lock
    instant = time.monotonic()
    with _lock:
        bucket = _attempts.setdefault(key, deque())
        _attempts.move_to_end(key)
        while bucket and instant - bucket[0] > window:
            bucket.popleft()
        if len(bucket) >= limit:
            raise HTTPException(429, "Too many login attempts; try again later", headers={"Retry-After": str(window)})
        bucket.append(instant)
        while len(_attempts) > 4096:
            _attempts.popitem(last=False)


class Login(BaseModel):
    username: str = Field(min_length=1, max_length=64)
    password: str = Field(min_length=1, max_length=1024)


@router.post("/login")
def login(body: Login, request: Request, response: Response):
    ip = request.client.host if request.client else "unknown"
    _throttle(request, f"ip:{ip}", limit=30, window=300)
    _throttle(request, f"user:{body.username.lower()}", limit=10, window=900)
    auth = request.app.state.auth
    result = auth.login(body.username, body.password, request, response)
    principal = auth._principal(request.app.state.db.one("SELECT * FROM users WHERE username=%s", (body.username.lower(),)))
    audit.record(request.app.state.db, principal, "auth.login", request=request)
    return result


@router.post("/logout")
def logout(request: Request, response: Response):
    principal = request.app.state.auth.current(request)
    request.app.state.auth.logout(request, response)
    if principal:
        audit.record(request.app.state.db, principal, "auth.logout", request=request)
    return {"ok": True}


@router.get("/me")
def me(request: Request):
    principal = request.app.state.auth.current(request)
    if principal is None:
        raise HTTPException(401, "Authentication required")
    row = request.app.state.db.one("SELECT * FROM users WHERE id=%s", (principal.user_id,))
    return {"user": request.app.state.auth.user_view(row)}


@router.get("/catalog")
def catalog(principal: Principal = Depends(require("sites:view"))):
    return {"permissions": PERMISSIONS, "roles": {k: sorted(v) for k, v in ROLE_DEFAULTS.items()}}


class PasswordChange(BaseModel):
    current_password: str = Field(min_length=1, max_length=1024)
    new_password: str = Field(min_length=12, max_length=1024)


@router.post("/password")
def change_password(body: PasswordChange, request: Request, response: Response,
                    principal: Principal = Depends(require("sites:view"))):
    db = request.app.state.db
    row = db.one("SELECT * FROM users WHERE id=%s", (principal.user_id,))
    if not verify_password(row["password_hash"], body.current_password):
        raise HTTPException(400, "Current password is incorrect")
    with db.transaction() as cur:
        cur.execute("UPDATE users SET password_hash=%s, password_changed_at=now() WHERE id=%s",
                    (hash_password(body.new_password), principal.user_id))
        cur.execute("UPDATE sessions SET revoked_at=now() WHERE user_id=%s AND revoked_at IS NULL", (principal.user_id,))
    audit.record(db, principal, "auth.password_change", request=request)
    response.delete_cookie("bambou_session", path="/")
    return {"ok": True, "message": "Password changed; sign in again"}


@router.get("/sessions")
def sessions(request: Request, principal: Principal = Depends(require("sites:view"))):
    rows = request.app.state.db.query(
        "SELECT id, user_agent, ip, created_at, last_seen_at, expires_at FROM sessions "
        "WHERE user_id=%s AND revoked_at IS NULL AND expires_at>now() ORDER BY last_seen_at DESC", (principal.user_id,))
    return [{**r, "id": str(r["id"])} for r in rows]


@router.delete("/sessions/{session_id}")
def revoke_session(session_id: str, request: Request, principal: Principal = Depends(require("sites:view"))):
    count = request.app.state.db.execute(
        "UPDATE sessions SET revoked_at=now() WHERE id=%s AND user_id=%s AND revoked_at IS NULL", (session_id, principal.user_id))
    if not count:
        raise HTTPException(404, "Session not found")
    audit.record(request.app.state.db, principal, "auth.session_revoke", target=session_id, request=request)
    return {"ok": True}
