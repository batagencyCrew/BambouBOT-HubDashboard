"""Session and agent-token authentication with FastAPI dependencies."""

from __future__ import annotations

import hashlib
import hmac
import secrets
from datetime import datetime, timedelta, timezone
from typing import Annotated

from fastapi import Depends, HTTPException, Request, Response

from .permissions import Principal, effective_permissions, resolve_scope
from .security import hash_password, needs_rehash, verify_password

SESSION_COOKIE = "bambou_session"


def sha256(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def now() -> datetime:
    return datetime.now(timezone.utc)


def token_hash_eq(stored: str, presented: str) -> bool:
    return hmac.compare_digest(stored, sha256(presented))


class Auth:
    def __init__(self, app):
        self.settings = app.state.settings
        self.db = app.state.db
        self.secure = self.settings.secure_cookies

    # -- sessions ---------------------------------------------------------
    def login(self, username: str, password: str, request: Request, response: Response) -> dict:
        row = self.db.one("SELECT * FROM users WHERE username=%s", (username.lower(),))
        # Always run a hash comparison so unknown users do not answer faster.
        stored = row["password_hash"] if row else "$argon2id$v=19$m=65536,t=3,p=2$YWJjZGVmZ2hpamtsbW5vcA$1"
        ok = verify_password(stored, password) and row is not None
        if not ok:
            raise HTTPException(401, "Invalid username or password")
        if row["disabled"]:
            raise HTTPException(403, "Account disabled")
        if needs_rehash(row["password_hash"]):
            self.db.execute("UPDATE users SET password_hash=%s WHERE id=%s", (hash_password(password), row["id"]))
        token = secrets.token_urlsafe(48)
        expires = now() + timedelta(seconds=self.settings.session_ttl)
        self.db.execute(
            "INSERT INTO sessions(user_id, token_hash, user_agent, ip, expires_at) VALUES(%s,%s,%s,%s,%s)",
            (row["id"], sha256(token), request.headers.get("user-agent", "")[:300],
             (request.client.host if request.client else "")[:64], expires))
        self.db.execute("UPDATE users SET last_login_at=now() WHERE id=%s", (row["id"],))
        response.set_cookie(SESSION_COOKIE, token, max_age=self.settings.session_ttl,
                            httponly=True, secure=self.secure, samesite="strict", path="/")
        return {"user": self.user_view(row), "expires_at": expires.isoformat()}

    def logout(self, request: Request, response: Response) -> None:
        token = request.cookies.get(SESSION_COOKIE)
        if token:
            self.db.execute("UPDATE sessions SET revoked_at=now() WHERE token_hash=%s AND revoked_at IS NULL", (sha256(token),))
        response.delete_cookie(SESSION_COOKIE, path="/")

    def current(self, request: Request) -> Principal | None:
        cached = getattr(request.state, "principal", None)
        if cached is not None:
            return cached
        principal = self._resolve(request)
        request.state.principal = principal
        return principal

    def _resolve(self, request: Request) -> Principal | None:
        token = request.cookies.get(SESSION_COOKIE)
        if not token:
            header = request.headers.get("authorization", "")
            if header.lower().startswith("bearer "):
                token = header[7:].strip()
        if not token or len(token) > 200:
            return None
        if token.startswith("hbt_"):
            return self._bot_principal(token, request)
        row = self.db.one(
            "SELECT u.*, s.id AS session_id FROM sessions s JOIN users u ON u.id=s.user_id "
            "WHERE s.token_hash=%s AND s.revoked_at IS NULL AND s.expires_at>now() AND u.disabled=false",
            (sha256(token),))
        if not row:
            return None
        self.db.execute("UPDATE sessions SET last_seen_at=now() WHERE id=%s", (row["session_id"],))
        return self._principal(row)

    def _principal(self, row: dict, **extra) -> Principal:
        return Principal(
            user_id=str(row["id"]), username=row["username"], role=row["role"],
            permissions=effective_permissions(row["role"], row["permissions"]),
            site_scope=resolve_scope([str(s) for s in row["site_scope"]] if row["site_scope"] else None),
            **extra,
        )

    def _bot_principal(self, token: str, request: Request) -> Principal | None:
        """A bot service token acts *as* the linked chat user, never as itself.

        The bot must send ``X-Bot-User: <platform>:<platform user id>``. Unlinked
        chat users have no hub permissions; the bot's token alone grants nothing
        except the identity lookups under /api/bot.
        """
        service = self.db.one(
            "SELECT id FROM service_tokens WHERE token_hash=%s AND revoked_at IS NULL AND kind='bot'", (sha256(token),))
        if not service:
            return None
        self.db.execute("UPDATE service_tokens SET last_used_at=now() WHERE id=%s", (service["id"],))
        request.state.bot_service = str(service["id"])
        identity = request.headers.get("x-bot-user", "")
        platform, _, platform_user = identity.partition(":")
        if platform not in ("discord", "telegram") or not platform_user or len(platform_user) > 64:
            return None
        row = self.db.one(
            "SELECT u.* FROM bot_links b JOIN users u ON u.id=b.user_id "
            "WHERE b.platform=%s AND b.platform_user=%s AND u.disabled=false", (platform, platform_user))
        if not row:
            return None
        return self._principal(row, source="bot", bot_platform=platform, bot_user=platform_user)

    def bot_service(self, request: Request) -> str:
        header = request.headers.get("authorization", "")
        token = header[7:].strip() if header.lower().startswith("bearer ") else ""
        if not token.startswith("hbt_"):
            raise HTTPException(401, "Bot service token required")
        row = self.db.one(
            "SELECT id FROM service_tokens WHERE token_hash=%s AND revoked_at IS NULL AND kind='bot'", (sha256(token),))
        if not row:
            raise HTTPException(401, "Invalid bot service token")
        return str(row["id"])

    @staticmethod
    def user_view(row: dict) -> dict:
        return {
            "id": str(row["id"]), "username": row["username"], "display_name": row["display_name"],
            "role": row["role"], "permissions": sorted(effective_permissions(row["role"], row["permissions"])),
            "extra_permissions": list(row["permissions"]),
            "site_scope": [str(s) for s in row["site_scope"]] if row["site_scope"] else None,
            "disabled": row["disabled"], "created_at": row["created_at"], "last_login_at": row["last_login_at"],
        }

    # -- agent tokens -----------------------------------------------------
    def site_token(self, request: Request) -> str:
        header = request.headers.get("authorization", "")
        if not header.lower().startswith("bearer "):
            raise HTTPException(401, "Agent token required", headers={"WWW-Authenticate": "Bearer"})
        token = header[7:].strip()
        if not token or len(token) > 200:
            raise HTTPException(401, "Agent token required")
        row = self.db.one(
            "SELECT * FROM site_tokens WHERE token_hash=%s AND revoked_at IS NULL", (sha256(token),))
        if not row:
            raise HTTPException(401, "Invalid agent token")
        self.db.execute("UPDATE site_tokens SET last_used_at=now() WHERE id=%s", (row["id"],))
        return str(row["site_id"])

    def issue_site_token(self, site_id: str, label: str, user_id: str | None) -> str:
        token = "hst_" + secrets.token_urlsafe(40)
        self.db.execute(
            "INSERT INTO site_tokens(site_id, token_hash, label, created_by) VALUES(%s,%s,%s,%s)",
            (site_id, sha256(token), label[:100], user_id))
        return token


def require(permission: str):
    """FastAPI dependency asserting a session principal holds a permission."""
    def dependency(request: Request) -> Principal:
        principal = request.app.state.auth.current(request)
        if principal is None:
            raise HTTPException(401, "Authentication required")
        if not principal.can(permission):
            raise HTTPException(403, f"Missing permission: {permission}")
        return principal
    return dependency


PrincipalDep = Annotated[Principal, Depends(require("sites:view"))]
