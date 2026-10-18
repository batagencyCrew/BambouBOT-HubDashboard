"""SQLite-backed dashboard API. No endpoint fetches user-supplied URLs."""

import asyncio
import hashlib
import hmac
import json
import logging
import math
import os
import secrets
import sqlite3
import threading
import time
from collections import OrderedDict, deque
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Annotated, Literal
from urllib.parse import urlsplit
from uuid import UUID, uuid4

from cryptography.fernet import Fernet, InvalidToken
import httpx
from fastapi import Depends, FastAPI, HTTPException, Query, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer
from pydantic import BaseModel, ConfigDict, Field, SecretStr, field_validator, model_validator

from .proxy_import import parse_file, parse_proxy


TOKEN_TTL = 8 * 60 * 60
MAX_BODY = 1024 * 1024
MAX_SITES = 1000
MAX_PROXIES = 1000
MAX_HISTORY = 1000
MAX_WORKERS = 100
MAX_PRESETS = 1000
MAX_PRESETS_BYTES = 1024 * 1024
PRESETS_TIMEOUT = 10.0
PRESETS_URL = "https://bambouaibot.com/api/assistant/presets"


def now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def uid() -> str:
    return str(uuid4())


def validate_url(value: str, schemes: set[str]) -> str:
    try:
        parsed = urlsplit(value)
        if (
            parsed.scheme not in schemes
            or not parsed.hostname
            or parsed.username is not None
            or parsed.password is not None
            or parsed.fragment
            or any(c.isspace() or ord(c) < 32 or ord(c) == 127 for c in value)
            or "\\" in value
        ):
            raise ValueError()
        parsed.port  # Validate invalid/out-of-range port numbers.
    except ValueError:
        raise ValueError("Invalid URL: allowed scheme, hostname, no credentials or fragment required") from None
    return value


class Model(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=False, allow_inf_nan=False)


class Login(Model):
    password: SecretStr = Field(min_length=1, max_length=4096)


class SiteCreate(Model):
    name: str = Field(min_length=1, max_length=200)
    url: str = Field(min_length=1, max_length=2048)
    description: str = Field(default="", max_length=4000)

    @field_validator("name")
    @classmethod
    def name_not_blank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("Name must not be blank")
        return value.strip()

    @field_validator("url")
    @classmethod
    def site_url(cls, value: str) -> str:
        return validate_url(value, {"http", "https"})


class SitePatch(SiteCreate):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    url: str | None = Field(default=None, min_length=1, max_length=2048)
    description: str | None = Field(default=None, max_length=4000)

    @model_validator(mode="before")
    @classmethod
    def no_null(cls, values):
        if isinstance(values, dict) and any(value is None for value in values.values()):
            raise ValueError("Fields cannot be null")
        return values


class ConfigUpdate(Model):
    ai_api_key: SecretStr | None = Field(default=None, max_length=8192)
    captcha_api_key: SecretStr | None = Field(default=None, max_length=8192)
    number_of_workers: int = Field(ge=0, le=MAX_WORKERS, strict=True)
    ai_preset_id: str = Field(min_length=1, max_length=200)

    @model_validator(mode="before")
    @classmethod
    def no_null_secrets(cls, values):
        if isinstance(values, dict) and any(k in values and values[k] is None for k in ("ai_api_key", "captcha_api_key")):
            raise ValueError("Omit secrets to preserve them; use an empty string to clear")
        return values


class PresetsRequest(Model):
    ai_api_key: SecretStr | None = Field(default=None, max_length=8192)

    @model_validator(mode="before")
    @classmethod
    def no_null_key(cls, values):
        if isinstance(values, dict) and "ai_api_key" in values and values["ai_api_key"] is None:
            raise ValueError("Omit the API key to use the saved key")
        return values


class LocalConfig(Model):
    ai_api_key: SecretStr = Field(default=SecretStr(""), max_length=8192)
    number_of_workers: int = Field(default=1, ge=0, le=MAX_WORKERS, strict=True)
    ai_preset_id: str = Field(default="default", min_length=1, max_length=200)


class LocalSync(Model):
    expected_revision: int = Field(ge=0, strict=True)
    config: LocalConfig = Field(default_factory=LocalConfig)
    proxies_content: str = Field(default="", repr=False)


def fetch_presets(api_key: str) -> dict:
    """Fetch a bounded, normalized catalogue without forwarding provider errors."""
    # The sync route runs in FastAPI's worker pool, not an existing event loop.
    # asyncio.run also closes the loop and drains cancelled tasks before returning.
    return asyncio.run(_fetch_presets(api_key))


async def _fetch_presets(api_key: str) -> dict:
    invalid_response = "Preset provider returned an invalid response"
    try:
        # HTTPX's timeout alone resets for every read; a slow-drip response must
        # also be cancelled after the overall connection + streaming deadline.
        async with asyncio.timeout(PRESETS_TIMEOUT):
            async with httpx.AsyncClient(timeout=10.0, follow_redirects=False, verify=True, trust_env=False) as client:
                async with client.stream("GET", PRESETS_URL, headers={"Authorization": f"Bearer {api_key}"}) as response:
                    if response.status_code in (401, 403):
                        raise HTTPException(400, "Invalid AI API key; check the supplied or saved key")
                    if response.status_code == 429:
                        raise HTTPException(503, "Preset provider rate limit reached; try again later")
                    if response.status_code != 200:
                        raise HTTPException(502, "Preset provider request failed")
                    content = bytearray()
                    async for chunk in response.aiter_bytes(chunk_size=65536):
                        if len(content) + len(chunk) > MAX_PRESETS_BYTES:
                            raise HTTPException(502, invalid_response)
                        content.extend(chunk)
        payload = json.loads(content)
        if not isinstance(payload, dict) or not isinstance(payload.get("presets"), list) or len(payload["presets"]) > MAX_PRESETS:
            raise ValueError()
        presets = []
        for item in payload["presets"]:
            if not isinstance(item, dict):
                raise ValueError()
            preset_id = item.get("id")
            if type(preset_id) in (int, float):
                if isinstance(preset_id, float) and not math.isfinite(preset_id):
                    raise ValueError()
                preset_id = str(preset_id)
            name, archived = item.get("name"), item.get("archived", False)
            if (not isinstance(preset_id, str) or not 1 <= len(preset_id.strip()) <= 200
                    or not isinstance(name, str) or not 1 <= len(name.strip()) <= 200
                    or type(archived) is not bool):
                raise ValueError()
            presets.append({"id": preset_id.strip(), "name": name.strip(), "archived": archived})
        return {"presets": presets}
    except (httpx.TimeoutException, TimeoutError):
        raise HTTPException(504, "Preset provider timed out; try again later") from None
    except httpx.HTTPError:
        raise HTTPException(502, "Unable to contact preset provider") from None
    except (ValueError, UnicodeError, RecursionError):
        raise HTTPException(502, invalid_response) from None


class ProxyCreate(Model):
    url: str = Field(min_length=1, max_length=2048)
    username: str = Field(default="", max_length=512)
    password: SecretStr = Field(default=SecretStr(""), max_length=4096)

    @field_validator("url")
    @classmethod
    def proxy_url(cls, value: str) -> str:
        return validate_url(value, {"http", "https", "socks5"})


class ProxyImport(Model):
    content: str = Field(repr=False)
    proxy_type: Literal["http", "https", "socks5"] = "http"
    dry_run: bool = Field(default=True, strict=True)


class CommandCreate(Model):
    action: Literal["start", "stop", "restart"]


class Ack(Model):
    status: Literal["completed", "failed"]
    message: str | None = Field(default=None, max_length=4000)


class WorkerInput(Model):
    id: UUID
    name: str = Field(min_length=1, max_length=200)
    status: Literal["running", "idle", "error", "stopped"]
    # psutil uses 100% per core; a multithreaded worker can exceed 100%.
    cpu_percent: float = Field(default=0, ge=0, le=100_000)
    memory_mb: float = Field(default=0, ge=0, le=1_000_000_000)
    tasks_completed: int = Field(default=0, ge=0, le=2**63 - 1, strict=True)


class Heartbeat(Model):
    status: Literal["healthy", "degraded"]
    workers: list[WorkerInput] = Field(max_length=MAX_WORKERS)

    @model_validator(mode="after")
    def unique_workers(self):
        if len({w.id for w in self.workers}) != len(self.workers):
            raise ValueError("Worker IDs must be unique")
        return self


class StatisticsInput(Model):
    links_sent_successfully: int = Field(ge=0, le=9007199254740991, strict=True)
    average_messages_per_chat: float | None = Field(ge=0, le=1_000_000_000, strict=True)


class ErrorInput(Model):
    worker_id: UUID | None = None
    level: Literal["info", "warning", "error"]
    message: str = Field(min_length=1, max_length=8000)


def persistent_key(path: Path, generate) -> bytes:
    """Atomically publish a complete key; competing processes use the same winner."""
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    except FileNotFoundError:
        temporary = path.with_name(f".{path.name}.{secrets.token_hex(16)}")
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        try:
            with os.fdopen(fd, "wb") as stream:
                stream.write(generate())
                stream.flush()
                os.fsync(stream.fileno())
            try:
                # link() never overwrites: unlike rename(), this is safe when
                # several first-start workers generate keys concurrently.
                os.link(temporary, path, follow_symlinks=False)
            except FileExistsError:
                pass
            directory_fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
        finally:
            temporary.unlink()
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "rb", closefd=False) as stream:
            value = stream.read(4097)
    finally:
        os.close(fd)
    if not value or len(value) > 4096:
        raise RuntimeError(f"Invalid persistent key file: {path.name}")
    return value


class Storage:
    def __init__(self, directory: Path):
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(directory, 0o700)
        self.path = directory / "hub.sqlite3"
        self.lock = threading.RLock()
        if self.path.is_symlink():
            raise RuntimeError("Database must not be a symlink")
        fd = os.open(self.path, os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        os.fchmod(fd, 0o600)
        os.close(fd)
        with self.transaction() as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS sites (
                    id TEXT PRIMARY KEY, name TEXT NOT NULL, url TEXT NOT NULL,
                    description TEXT NOT NULL, desired_state TEXT NOT NULL DEFAULT 'stopped',
                    reported_status TEXT NOT NULL DEFAULT 'healthy', last_seen TEXT,
                    created_at TEXT NOT NULL, token_hash TEXT UNIQUE NOT NULL
                );
                CREATE TABLE IF NOT EXISTS configs (
                    site_id TEXT PRIMARY KEY REFERENCES sites(id) ON DELETE CASCADE,
                    number_of_workers INTEGER NOT NULL DEFAULT 1,
                    ai_preset_id TEXT NOT NULL DEFAULT 'default',
                    ai_api_key TEXT NOT NULL DEFAULT '', captcha_api_key TEXT NOT NULL DEFAULT '',
                    updated_at TEXT NOT NULL,
                    revision INTEGER NOT NULL DEFAULT 0,
                    admin_modified INTEGER NOT NULL DEFAULT 0,
                    local_sync_initialized INTEGER NOT NULL DEFAULT 0
                );
                CREATE TABLE IF NOT EXISTS workers (
                    site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
                    id TEXT NOT NULL, name TEXT NOT NULL, status TEXT NOT NULL,
                    cpu_percent REAL NOT NULL, memory_mb REAL NOT NULL,
                    tasks_completed INTEGER NOT NULL, last_seen TEXT NOT NULL,
                    PRIMARY KEY (site_id, id)
                );
                CREATE TABLE IF NOT EXISTS proxies (
                    id TEXT PRIMARY KEY, site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
                    url TEXT NOT NULL, username TEXT NOT NULL, password TEXT NOT NULL,
                    created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS errors (
                    id TEXT PRIMARY KEY, site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
                    worker_id TEXT, level TEXT NOT NULL, message TEXT NOT NULL, timestamp TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS errors_site_time ON errors(site_id, timestamp DESC);
                CREATE TABLE IF NOT EXISTS commands (
                    id TEXT PRIMARY KEY, site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
                    action TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
                    created_at TEXT NOT NULL, completed_at TEXT, message TEXT
                );
                CREATE INDEX IF NOT EXISTS commands_site_time ON commands(site_id, created_at DESC);
                CREATE INDEX IF NOT EXISTS proxies_site ON proxies(site_id);
                CREATE TABLE IF NOT EXISTS statistics (
                    site_id TEXT PRIMARY KEY REFERENCES sites(id) ON DELETE CASCADE,
                    links_sent_successfully INTEGER NOT NULL
                        CHECK (links_sent_successfully BETWEEN 0 AND 9007199254740991),
                    average_messages_per_chat REAL
                        CHECK (average_messages_per_chat BETWEEN 0 AND 1000000000),
                    updated_at TEXT NOT NULL
                );
            """)
            # executescript commits its surrounding transaction. Reacquire the
            # SQLite write lock before inspecting/migrating (also multi-process).
            db.execute("BEGIN IMMEDIATE")
            columns = {row["name"] for row in db.execute("PRAGMA table_info(configs)")}
            legacy = "admin_modified" not in columns
            for column in ("revision", "admin_modified", "local_sync_initialized"):
                if column not in columns:
                    db.execute(f"ALTER TABLE configs ADD COLUMN {column} INTEGER NOT NULL DEFAULT 0")
            if legacy:
                # Historical deletes/writes cannot be inferred from current data.
                # Fail closed for all pre-migration sites, even apparently empty ones.
                db.execute("UPDATE configs SET admin_modified=1")

    @contextmanager
    def transaction(self):
        with self.lock:
            db = sqlite3.connect(self.path, timeout=15)
            db.row_factory = sqlite3.Row
            db.execute("PRAGMA foreign_keys=ON")
            try:
                db.execute("BEGIN IMMEDIATE")
                yield db
                db.commit()
            except BaseException:
                db.rollback()
                raise
            finally:
                db.close()


class BodyLimit:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope.get("path") == "/api/agent/backups/upload":
            return await self.app(scope, receive, send)
        # Bound streamed bodies as well as Content-Length. Buffer before routing so
        # a rejected request cannot partially mutate persistent state.
        chunks, total = [], 0
        while True:
            message = await receive()
            if message["type"] == "http.disconnect":
                return
            total += len(message.get("body", b""))
            if total > MAX_BODY:
                return await JSONResponse({"detail": "Request body too large"}, status_code=413)(scope, receive, send)
            if message.get("body"):
                chunks.append(message["body"])
            if not message.get("more_body", False):
                break
        consumed = False

        async def replay():
            nonlocal consumed
            if not consumed:
                consumed = True
                return {"type": "http.request", "body": b"".join(chunks), "more_body": False}
            return await receive()

        await self.app(scope, replay, send)


def create_app(
    *, data_dir: str | Path | None = None, admin_password: str | None = None,
    encryption_key: str | bytes | None = None, frontend_dir: str | Path | None = None,
) -> FastAPI:
    password = admin_password if admin_password is not None else os.environ.get("HUB_ADMIN_PASSWORD")
    if not password or not password.strip():
        raise RuntimeError("HUB_ADMIN_PASSWORD is required and must not be blank")
    password_digest = hashlib.sha256(password.encode()).digest()
    del password
    directory = Path(data_dir or os.environ.get("HUB_DATA_DIR", "./data")).resolve()
    store = Storage(directory)
    key = encryption_key if encryption_key is not None else os.environ.get("HUB_ENCRYPTION_KEY")
    if key is None:
        key = persistent_key(directory / "encryption.key", Fernet.generate_key)
    if isinstance(key, str):
        key = key.encode()
    try:
        cipher = Fernet(key)
    except (ValueError, TypeError):
        raise RuntimeError("HUB_ENCRYPTION_KEY must be a valid Fernet key") from None
    # Fail closed on a wrong/lost encryption key before accepting traffic.
    with store.transaction() as db:
        encrypted_values = db.execute(
            "SELECT ai_api_key AS value FROM configs WHERE ai_api_key!='' "
            "UNION ALL SELECT captcha_api_key FROM configs WHERE captcha_api_key!='' "
            "UNION ALL SELECT password FROM proxies WHERE password!=''"
        )
        try:
            for row in encrypted_values:
                cipher.decrypt(row["value"].encode())
        except (InvalidToken, ValueError):
            raise RuntimeError("Stored secrets cannot be decrypted; restore the original HUB_ENCRYPTION_KEY or encryption.key") from None
    signing_key = persistent_key(directory / "signing.key", lambda: secrets.token_bytes(64))
    if len(signing_key) < 32:
        raise RuntimeError("Persistent signing key is invalid")
    signer = URLSafeTimedSerializer(signing_key, salt="hub-dashboard-admin-v1", signer_kwargs={"digest_method": hashlib.sha256})
    auth_version = hmac.new(signing_key, b"admin-password-version:" + password_digest, hashlib.sha256).hexdigest()
    app = FastAPI(title="Hub Dashboard", docs_url=None, redoc_url=None, openapi_url=None)
    app.state.store = store
    app.add_middleware(BodyLimit)
    origins = [v.strip() for v in os.environ.get("HUB_CORS_ORIGINS", "").split(",") if v.strip()]
    for origin in origins:
        validate_url(origin, {"http", "https"})
        if "*" in origin or urlsplit(origin).path or urlsplit(origin).query:
            raise RuntimeError("HUB_CORS_ORIGINS must contain explicit origins without paths")
    if origins:
        app.add_middleware(CORSMiddleware, allow_origins=origins, allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"], allow_headers=["Authorization", "Content-Type"])

    @app.middleware("http")
    async def secure_headers(request: Request, call_next):
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["X-Frame-Options"] = "DENY"
        if request.url.path.startswith("/api"):
            response.headers["Cache-Control"] = "no-store"
        return response

    @app.exception_handler(RequestValidationError)
    async def invalid_input(request, exc):
        # Pydantic's default errors include input values (including passwords).
        if request.url.path == "/api/agent/local-sync":
            logging.getLogger(__name__).warning("Invalid local sync request")
            return JSONResponse(status_code=422, content={"detail": "Invalid local sync request"})
        if request.url.path.endswith("/proxies/import"):
            return JSONResponse(status_code=422, content={"detail": "Invalid proxy import request"})
        return JSONResponse(status_code=422, content={"detail": [
            {"loc": list(e["loc"]), "type": e["type"], "msg": "Invalid input"}
            for e in exc.errors()
        ]})

    bearer = HTTPBearer(auto_error=False)

    def unauthorized():
        return HTTPException(401, "Invalid or expired credentials", headers={"WWW-Authenticate": "Bearer"})

    def credential_value(credentials: HTTPAuthorizationCredentials | None) -> str:
        if credentials is None or credentials.scheme.lower() != "bearer" or len(credentials.credentials) > 4096:
            raise unauthorized()
        return credentials.credentials

    def admin(credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer)]):
        token = credential_value(credentials)
        try:
            payload = signer.loads(token, max_age=TOKEN_TTL)
        except (BadSignature, SignatureExpired):
            raise unauthorized() from None
        if (not isinstance(payload, dict) or payload.get("role") != "admin"
                or not isinstance(payload.get("auth_version"), str)
                or not hmac.compare_digest(payload["auth_version"], auth_version)):
            raise unauthorized()

    def agent(credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer)]) -> str:
        token_hash = hashlib.sha256(credential_value(credentials).encode()).hexdigest()
        with store.transaction() as db:
            row = db.execute("SELECT id FROM sites WHERE token_hash=?", (token_hash,)).fetchone()
        if row is None:
            raise unauthorized()
        return row["id"]

    def site_row(db, site_id: str):
        row = db.execute("SELECT * FROM sites WHERE id=?", (site_id,)).fetchone()
        if row is None:
            raise HTTPException(404, "Site not found")
        return row

    def site_output(db, row):
        workers = db.execute("SELECT status FROM workers WHERE site_id=?", (row["id"],)).fetchall()
        healthy = sum(w["status"] in ("running", "idle") for w in workers)
        fresh = row["last_seen"] is not None and (datetime.now(timezone.utc) - datetime.fromisoformat(row["last_seen"].replace("Z", "+00:00"))).total_seconds() < 60
        status = "offline" if not fresh else "degraded" if row["reported_status"] == "degraded" or any(w["status"] == "error" for w in workers) else "healthy"
        return {**{k: row[k] for k in ("id", "name", "url", "description", "desired_state", "last_seen", "created_at")}, "status": status, "worker_count": len(workers), "healthy_workers": healthy}

    def config_output(row):
        return {"number_of_workers": row["number_of_workers"], "ai_preset_id": row["ai_preset_id"], "has_ai_api_key": bool(row["ai_api_key"]), "has_captcha_api_key": bool(row["captcha_api_key"]), "updated_at": row["updated_at"], "revision": row["revision"]}

    def proxy_output(row):
        return {**{k: row[k] for k in ("id", "url", "username", "created_at")}, "has_password": bool(row["password"])}

    def command_output(row):
        return {k: row[k] for k in ("id", "action", "status", "created_at", "completed_at", "message")}

    def statistics_output(db, site_id):
        row = db.execute("SELECT * FROM statistics WHERE site_id=?", (site_id,)).fetchone()
        return {"site_id": site_id, **{
            key: row[key] if row is not None else None
            for key in ("links_sent_successfully", "average_messages_per_chat", "updated_at")
        }}

    def encrypt(value: str) -> str:
        return cipher.encrypt(value.encode()).decode() if value else ""

    def decrypt(value: str) -> str:
        return cipher.decrypt(value.encode()).decode() if value else ""

    def agent_config_output(db, site_id):
        row = db.execute("SELECT * FROM configs WHERE site_id=?", (site_id,)).fetchone()
        return {"number_of_workers": row["number_of_workers"], "ai_preset_id": row["ai_preset_id"],
                "ai_api_key": decrypt(row["ai_api_key"]), "captcha_api_key": decrypt(row["captcha_api_key"]),
                "revision": row["revision"], "local_sync_initialized": bool(row["local_sync_initialized"]),
                "proxies": [{"id": p["id"], "url": p["url"], "username": p["username"], "password": decrypt(p["password"])}
                            for p in db.execute("SELECT * FROM proxies WHERE site_id=? ORDER BY created_at,id", (site_id,))]}

    def admin_config_changed(db, site_id):
        db.execute("UPDATE configs SET admin_modified=1,revision=revision+1,updated_at=? WHERE site_id=?", (now(), str(site_id)))

    def error_rows(db, site_id=None, limit=100):
        query = "SELECT e.*, s.name AS site_name FROM errors e JOIN sites s ON s.id=e.site_id"
        args = []
        if site_id is not None:
            query += " WHERE e.site_id=?"
            args.append(site_id)
        return [dict(r) for r in db.execute(query + " ORDER BY e.timestamp DESC,e.rowid DESC LIMIT ?", (*args, limit))]

    login_attempts: OrderedDict[str, deque] = OrderedDict()
    login_lock = threading.Lock()

    @app.get("/api/health")
    def health():
        return {"status": "ok"}

    @app.post("/api/auth/login")
    def login(body: Login, request: Request):
        host = request.client.host if request.client else "unknown"
        instant = time.monotonic()
        with login_lock:
            attempts = login_attempts.setdefault(host, deque())
            login_attempts.move_to_end(host)
            while attempts and instant - attempts[0] >= 60:
                attempts.popleft()
            if len(attempts) >= 10:
                raise HTTPException(429, "Too many login attempts", headers={"Retry-After": "60"})
            attempts.append(instant)
            while len(login_attempts) > 2048:
                login_attempts.popitem(last=False)
        if not hmac.compare_digest(hashlib.sha256(body.password.get_secret_value().encode()).digest(), password_digest):
            raise unauthorized()
        return {"access_token": signer.dumps({"role": "admin", "auth_version": auth_version, "nonce": secrets.token_hex(16)}), "token_type": "bearer", "expires_in": TOKEN_TTL}

    admin_dependencies = [Depends(admin)]

    @app.get("/api/overview", dependencies=admin_dependencies)
    def overview():
        with store.transaction() as db:
            sites = [site_output(db, r) for r in db.execute("SELECT * FROM sites ORDER BY created_at,id")]
            running = db.execute("SELECT COUNT(*) FROM workers WHERE status='running'").fetchone()[0]
            return {"sites": sites, "recent_errors": error_rows(db), "summary": {"sites": len(sites), "healthy": sum(s["status"] == "healthy" for s in sites), "workers": sum(s["worker_count"] for s in sites), "running": running}}

    @app.get("/api/sites", dependencies=admin_dependencies)
    def list_sites():
        with store.transaction() as db:
            return [site_output(db, r) for r in db.execute("SELECT * FROM sites ORDER BY created_at,id")]

    @app.post("/api/sites", dependencies=admin_dependencies, status_code=201)
    def create_site(body: SiteCreate):
        site_id, token, timestamp = uid(), secrets.token_urlsafe(48), now()
        with store.transaction() as db:
            if db.execute("SELECT COUNT(*) FROM sites").fetchone()[0] >= MAX_SITES:
                raise HTTPException(409, "Site limit reached")
            db.execute("INSERT INTO sites(id,name,url,description,created_at,token_hash) VALUES(?,?,?,?,?,?)", (site_id, body.name, body.url, body.description, timestamp, hashlib.sha256(token.encode()).hexdigest()))
            db.execute("INSERT INTO configs(site_id,updated_at) VALUES(?,?)", (site_id, timestamp))
            return {"site": site_output(db, site_row(db, site_id)), "agent_token": token}

    @app.get("/api/sites/{site_id}", dependencies=admin_dependencies)
    def get_site(site_id: UUID):
        with store.transaction() as db:
            return site_output(db, site_row(db, str(site_id)))

    @app.patch("/api/sites/{site_id}", dependencies=admin_dependencies)
    def patch_site(site_id: UUID, body: SitePatch):
        with store.transaction() as db:
            row = site_row(db, str(site_id))
            values = body.model_dump(exclude_unset=True)
            db.execute("UPDATE sites SET name=?,url=?,description=? WHERE id=?", (values.get("name", row["name"]), values.get("url", row["url"]), values.get("description", row["description"]), str(site_id)))
            return site_output(db, site_row(db, str(site_id)))

    @app.delete("/api/sites/{site_id}", dependencies=admin_dependencies, status_code=204)
    def delete_site(site_id: UUID):
        with app.state.backups.file_lock, store.transaction() as db:
            site_row(db, str(site_id))
            app.state.backups.guard_site_deletion(db, str(site_id))
            db.execute("DELETE FROM sites WHERE id=?", (str(site_id),))
        return Response(status_code=204)

    @app.get("/api/sites/{site_id}/workers", dependencies=admin_dependencies)
    def workers(site_id: UUID):
        with store.transaction() as db:
            site_row(db, str(site_id))
            return [{k: r[k] for k in ("id", "name", "status", "cpu_percent", "memory_mb", "tasks_completed", "last_seen")} for r in db.execute("SELECT * FROM workers WHERE site_id=? ORDER BY name,id", (str(site_id),))]

    @app.get("/api/sites/{site_id}/statistics", dependencies=admin_dependencies)
    def statistics(site_id: UUID):
        with store.transaction() as db:
            site_row(db, str(site_id))
            return statistics_output(db, str(site_id))

    @app.get("/api/sites/{site_id}/errors", dependencies=admin_dependencies)
    def errors(site_id: UUID, limit: Annotated[int, Query(ge=1, le=1000)] = 100):
        with store.transaction() as db:
            site_row(db, str(site_id))
            return error_rows(db, str(site_id), limit)

    @app.get("/api/sites/{site_id}/config", dependencies=admin_dependencies)
    def config(site_id: UUID):
        with store.transaction() as db:
            site_row(db, str(site_id))
            return config_output(db.execute("SELECT * FROM configs WHERE site_id=?", (str(site_id),)).fetchone())

    @app.put("/api/sites/{site_id}/config", dependencies=admin_dependencies)
    def update_config(site_id: UUID, body: ConfigUpdate):
        with store.transaction() as db:
            site_row(db, str(site_id))
            row = db.execute("SELECT * FROM configs WHERE site_id=?", (str(site_id),)).fetchone()
            ai = encrypt(body.ai_api_key.get_secret_value()) if body.ai_api_key is not None else row["ai_api_key"]
            captcha = encrypt(body.captcha_api_key.get_secret_value()) if body.captcha_api_key is not None else row["captcha_api_key"]
            db.execute("UPDATE configs SET number_of_workers=?,ai_preset_id=?,ai_api_key=?,captcha_api_key=?,updated_at=? WHERE site_id=?", (body.number_of_workers, body.ai_preset_id, ai, captcha, now(), str(site_id)))
            admin_config_changed(db, site_id)
            return config_output(db.execute("SELECT * FROM configs WHERE site_id=?", (str(site_id),)).fetchone())

    @app.post("/api/sites/{site_id}/presets", dependencies=admin_dependencies)
    def presets(site_id: UUID, body: PresetsRequest):
        with store.transaction() as db:
            site_row(db, str(site_id))
            row = db.execute("SELECT ai_api_key FROM configs WHERE site_id=?", (str(site_id),)).fetchone()
            api_key = body.ai_api_key.get_secret_value() if body.ai_api_key is not None else decrypt(row["ai_api_key"])
        # Never hold SQLite's write transaction or storage lock during network I/O.
        if not api_key or not api_key.strip():
            raise HTTPException(400, "AI API key required; supply a key or save one in the site configuration")
        if any(ord(c) < 33 or ord(c) > 126 for c in api_key):
            raise HTTPException(400, "Invalid AI API key format; check the supplied or saved key")
        return fetch_presets(api_key)

    @app.get("/api/sites/{site_id}/proxies", dependencies=admin_dependencies)
    def proxies(site_id: UUID):
        with store.transaction() as db:
            site_row(db, str(site_id))
            return [proxy_output(r) for r in db.execute("SELECT * FROM proxies WHERE site_id=? ORDER BY created_at,id", (str(site_id),))]

    @app.post("/api/sites/{site_id}/proxies", dependencies=admin_dependencies, status_code=201)
    def add_proxy(site_id: UUID, body: ProxyCreate):
        proxy_id = uid()
        with store.transaction() as db:
            site_row(db, str(site_id))
            if db.execute("SELECT COUNT(*) FROM proxies WHERE site_id=?", (str(site_id),)).fetchone()[0] >= MAX_PROXIES:
                raise HTTPException(409, "Proxy limit reached")
            db.execute("INSERT INTO proxies(id,site_id,url,username,password,created_at) VALUES(?,?,?,?,?,?)", (proxy_id, str(site_id), body.url, body.username, encrypt(body.password.get_secret_value()), now()))
            admin_config_changed(db, site_id)
            return proxy_output(db.execute("SELECT * FROM proxies WHERE id=?", (proxy_id,)).fetchone())

    @app.post("/api/sites/{site_id}/proxies/import", dependencies=admin_dependencies)
    def import_proxies(site_id: UUID, body: ProxyImport):
        total, entries, errors = parse_file(body.content, body.proxy_type)
        with store.transaction() as db:
            site_row(db, str(site_id))
            stored = db.execute("SELECT url,username,password FROM proxies WHERE site_id=?", (str(site_id),)).fetchall()
            identities = set()
            for row in stored:
                try:
                    url = parse_proxy(row["url"]).url
                except ValueError:
                    # Legacy manual entries can lack explicit ports or include paths.
                    continue
                identities.add((url, row["username"], decrypt(row["password"])))
            previews, new = [], []
            for entry in entries:
                duplicate = entry.identity in identities
                previews.append(entry.preview(duplicate))
                if not duplicate:
                    identities.add(entry.identity)
                    new.append(entry)
            if len(stored) + len(new) > MAX_PROXIES:
                errors.append({"line": 0, "message": "Site proxy limit of 1000 would be exceeded"})
            imported = 0
            if not body.dry_run and not errors:
                for entry in new:
                    db.execute("INSERT INTO proxies(id,site_id,url,username,password,created_at) VALUES(?,?,?,?,?,?)",
                               (uid(), str(site_id), entry.url, entry.username, encrypt(entry.password), now()))
                imported = len(new)
                if imported:
                    admin_config_changed(db, site_id)
            return {"total": total, "valid": len(new), "duplicates": len(entries) - len(new),
                    "imported": imported, "can_import": not errors and bool(new) and body.dry_run,
                    "errors": errors, "entries": previews}

    @app.delete("/api/sites/{site_id}/proxies/{proxy_id}", dependencies=admin_dependencies, status_code=204)
    def delete_proxy(site_id: UUID, proxy_id: UUID):
        with store.transaction() as db:
            site_row(db, str(site_id))
            if db.execute("DELETE FROM proxies WHERE site_id=? AND id=?", (str(site_id), str(proxy_id))).rowcount == 0:
                raise HTTPException(404, "Proxy not found")
            admin_config_changed(db, site_id)
        return Response(status_code=204)

    @app.post("/api/sites/{site_id}/commands", dependencies=admin_dependencies, status_code=201)
    def send_command(site_id: UUID, body: CommandCreate):
        command_id, timestamp = uid(), now()
        with store.transaction() as db:
            site_row(db, str(site_id))
            # Commands are desired-state operations, not a backlog to replay later.
            # Terminally cancel all obsolete unacknowledged actions atomically.
            db.execute("UPDATE commands SET status='failed',completed_at=?,message='Superseded by newer command' WHERE site_id=? AND status IN ('pending','delivered')", (timestamp, str(site_id)))
            db.execute("UPDATE sites SET desired_state=? WHERE id=?", ("stopped" if body.action == "stop" else "running", str(site_id)))
            db.execute("INSERT INTO commands(id,site_id,action,created_at) VALUES(?,?,?,?)", (command_id, str(site_id), body.action, timestamp))
            db.execute("DELETE FROM commands WHERE site_id=? AND id NOT IN (SELECT id FROM commands WHERE site_id=? ORDER BY created_at DESC,rowid DESC LIMIT ?)", (str(site_id), str(site_id), MAX_HISTORY))
            return command_output(db.execute("SELECT * FROM commands WHERE id=?", (command_id,)).fetchone())

    @app.get("/api/sites/{site_id}/commands", dependencies=admin_dependencies)
    def commands(site_id: UUID):
        with store.transaction() as db:
            site_row(db, str(site_id))
            return [command_output(r) for r in db.execute("SELECT * FROM commands WHERE site_id=? ORDER BY created_at DESC,rowid DESC LIMIT 20", (str(site_id),))]

    @app.post("/api/sites/{site_id}/agent-token", dependencies=admin_dependencies)
    def regenerate_token(site_id: UUID):
        token = secrets.token_urlsafe(48)
        with store.transaction() as db:
            site_row(db, str(site_id))
            db.execute("UPDATE sites SET token_hash=? WHERE id=?", (hashlib.sha256(token.encode()).hexdigest(), str(site_id)))
        return {"agent_token": token}

    @app.post("/api/agent/heartbeat")
    def heartbeat(body: Heartbeat, site_id: Annotated[str, Depends(agent)]):
        timestamp = now()
        with store.transaction() as db:
            site_row(db, site_id)
            db.execute("UPDATE sites SET reported_status=?,last_seen=? WHERE id=?", (body.status, timestamp, site_id))
            db.execute("DELETE FROM workers WHERE site_id=?", (site_id,))
            db.executemany("INSERT INTO workers(site_id,id,name,status,cpu_percent,memory_mb,tasks_completed,last_seen) VALUES(?,?,?,?,?,?,?,?)", [(site_id, str(w.id), w.name, w.status, w.cpu_percent, w.memory_mb, w.tasks_completed, timestamp) for w in body.workers])
            return {"site_id": site_id, "desired_state": site_row(db, site_id)["desired_state"], "server_time": timestamp}

    @app.post("/api/agent/statistics")
    def report_statistics(body: StatisticsInput, site_id: Annotated[str, Depends(agent)]):
        with store.transaction() as db:
            site_row(db, site_id)
            # Absolute whole-site snapshots: retries replace values, never add.
            db.execute(
                "INSERT INTO statistics(site_id,links_sent_successfully,average_messages_per_chat,updated_at) "
                "VALUES(?,?,?,?) ON CONFLICT(site_id) DO UPDATE SET "
                "links_sent_successfully=excluded.links_sent_successfully,"
                "average_messages_per_chat=excluded.average_messages_per_chat,updated_at=excluded.updated_at",
                (site_id, body.links_sent_successfully, body.average_messages_per_chat, now()),
            )
            return statistics_output(db, site_id)

    @app.get("/api/agent/config")
    def agent_config(site_id: Annotated[str, Depends(agent)]):
        with store.transaction() as db:
            site_row(db, site_id)
            return agent_config_output(db, site_id)

    @app.post("/api/agent/local-sync")
    def local_sync(body: LocalSync, site_id: Annotated[str, Depends(agent)]):
        with store.transaction() as db:
            site_row(db, site_id)
            row = db.execute("SELECT * FROM configs WHERE site_id=?", (site_id,)).fetchone()
            if body.expected_revision != row["revision"]:
                raise HTTPException(409, "Configuration revision changed; fetch latest and retry without local data")
            # Schema is always validated; file content is only relevant while
            # pristine. Never parse/reimport local files after hub ownership.
            if row["local_sync_initialized"]:
                return agent_config_output(db, site_id)
            if not row["admin_modified"]:
                _, entries, errors = parse_file(body.proxies_content, "http")
                if errors:
                    logging.getLogger(__name__).warning("Invalid local sync proxy content")
                    raise HTTPException(422, "Invalid local sync proxy content")
                config = body.config
                db.execute("UPDATE configs SET number_of_workers=?,ai_preset_id=?,ai_api_key=? WHERE site_id=?",
                           (config.number_of_workers, config.ai_preset_id, encrypt(config.ai_api_key.get_secret_value()), site_id))
                identities = set()
                for entry in entries:
                    if entry.identity in identities:
                        continue
                    identities.add(entry.identity)
                    db.execute("INSERT INTO proxies(id,site_id,url,username,password,created_at) VALUES(?,?,?,?,?,?)",
                               (uid(), site_id, entry.url, entry.username, encrypt(entry.password), now()))
            db.execute("UPDATE configs SET local_sync_initialized=1,revision=revision+1,updated_at=? WHERE site_id=?", (now(), site_id))
            return agent_config_output(db, site_id)

    @app.post("/api/agent/errors", status_code=201)
    def report_error(body: ErrorInput, site_id: Annotated[str, Depends(agent)]):
        error_id = uid()
        with store.transaction() as db:
            site_row(db, site_id)
            db.execute("INSERT INTO errors VALUES(?,?,?,?,?,?)", (error_id, site_id, str(body.worker_id) if body.worker_id else None, body.level, body.message, now()))
            db.execute("DELETE FROM errors WHERE site_id=? AND id NOT IN (SELECT id FROM errors WHERE site_id=? ORDER BY timestamp DESC,rowid DESC LIMIT ?)", (site_id, site_id, MAX_HISTORY))
        return {"id": error_id}

    @app.get("/api/agent/commands")
    def poll_commands(site_id: Annotated[str, Depends(agent)]):
        with store.transaction() as db:
            site_row(db, site_id)
            db.execute("UPDATE commands SET status='delivered' WHERE site_id=? AND status='pending'", (site_id,))
            return [command_output(r) for r in db.execute("SELECT * FROM commands WHERE site_id=? AND status='delivered' ORDER BY created_at,rowid", (site_id,))]

    @app.post("/api/agent/commands/{command_id}/ack")
    def ack_command(command_id: UUID, body: Ack, site_id: Annotated[str, Depends(agent)]):
        with store.transaction() as db:
            row = db.execute("SELECT * FROM commands WHERE id=? AND site_id=?", (str(command_id), site_id)).fetchone()
            if row is None:
                raise HTTPException(404, "Command not found")
            if row["status"] in ("completed", "failed"):
                if row["status"] == body.status and row["message"] != "Superseded by newer command":
                    return command_output(row)
                raise HTTPException(409, "Command is already terminal or superseded")
            db.execute("UPDATE commands SET status=?,message=?,completed_at=? WHERE id=? AND site_id=?", (body.status, body.message, now(), str(command_id), site_id))
            return command_output(db.execute("SELECT * FROM commands WHERE id=?", (str(command_id),)).fetchone())

    from .backups import install_backups
    install_backups(app, store, admin, agent, directory)

    frontend = Path(frontend_dir) if frontend_dir is not None else Path(__file__).resolve().parents[2] / "frontend" / "dist"
    frontend = frontend.resolve()

    @app.get("/{path:path}", include_in_schema=False)
    def static_frontend(path: str):
        if path == "api" or path.startswith("api/"):
            raise HTTPException(404, "API route not found")
        target = (frontend / path).resolve()
        if not target.is_relative_to(frontend):
            raise HTTPException(404, "Not found")
        if target.is_file():
            return FileResponse(target)
        # Missing asset requests must not receive HTML; client-side routes may.
        if path.startswith("assets/") or Path(path).suffix:
            raise HTTPException(404, "Not found")
        index = frontend / "index.html"
        if index.is_file():
            return FileResponse(index)
        raise HTTPException(404, "Frontend not built")

    return app
