"""Receipt/storage only. No provider calls or business-statistics mutations."""

import hashlib
import json
import os
import re
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Annotated
from uuid import UUID

from fastapi import Depends, HTTPException, Query
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

SAFE_INT = 9007199254740991
HISTORY_SITE = 9000
HISTORY_GLOBAL = 90000
RECEIPTS_SITE = 20000
RECEIPTS_GLOBAL = 200000
RETENTION_DAYS = 7


@dataclass
class Settings:
    history_site: int = HISTORY_SITE
    history_global: int = HISTORY_GLOBAL
    receipts_site: int = RECEIPTS_SITE
    receipts_global: int = RECEIPTS_GLOBAL
    retention_days: int = RETENTION_DAYS

    @classmethod
    def from_env(cls):
        values = {}
        for field, default in cls.__dataclass_fields__.items():
            name = "HUB_TELEMETRY_" + field.upper()
            raw = os.environ.get(name, str(default.default))
            # Keep SQLite LIMIT values representable and datetime arithmetic safe.
            maximum = 36500 if field == "retention_days" else 2**63 - 1
            if not re.fullmatch(r"[0-9]{1,19}", raw) or not 1 <= int(raw) <= maximum:
                raise RuntimeError(f"{name} must be a positive integer <= {maximum}")
            values[field] = int(raw)
        return cls(**values)


class Input(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)


class Chat(Input):
    event_id: UUID
    worker_id: UUID
    msgs_in: int = Field(strict=True, ge=0, le=SAFE_INT)
    msgs_out: int = Field(strict=True, ge=0, le=SAFE_INT)
    links: int = Field(strict=True, ge=0, le=SAFE_INT)
    converted: bool = Field(strict=True)
    duration: float = Field(strict=True, ge=0, le=604800)
    proxy_id: UUID | None = None
    room: str | None = Field(default=None, min_length=1, max_length=128, pattern=r"^[A-Za-z0-9_-]+$")
    random: bool | None = Field(default=None, strict=True)


class AIUsage(Input):
    event_id: UUID
    key_id: str = Field(min_length=1, max_length=80, pattern=r"^[A-Za-z0-9_.-]+$")
    calls: int = Field(strict=True, ge=0, le=SAFE_INT)
    error_429: int = Field(strict=True, ge=0, le=SAFE_INT)
    error_502: int = Field(strict=True, ge=0, le=SAFE_INT)
    latency_ms: float = Field(strict=True, ge=0)

    @field_validator("key_id")
    @classmethod
    def nonsecret_label(cls, value):
        if re.search(r"bbk_|sk[_-]|bearer", value, re.I):
            raise ValueError("Nonsecret label required")
        return value

    @model_validator(mode="after")
    def counts(self):
        if self.error_429 + self.error_502 > self.calls:
            raise ValueError("Error counts exceed calls")
        if self.calls == 0 and self.latency_ms != 0:
            raise ValueError("Zero calls requires zero latency")
        return self


def migrate(db):
    # Called while holding Storage's BEGIN IMMEDIATE, never executescript here.
    for sql in (
        "CREATE TABLE IF NOT EXISTS telemetry (seq INTEGER PRIMARY KEY AUTOINCREMENT, site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE, event_id TEXT NOT NULL, kind TEXT NOT NULL, digest TEXT NOT NULL, timestamp TEXT NOT NULL, payload TEXT, UNIQUE(site_id,event_id))",
        "CREATE INDEX IF NOT EXISTS telemetry_site ON telemetry(site_id,seq)",
        "CREATE INDEX IF NOT EXISTS telemetry_time ON telemetry(timestamp)",
        "CREATE TABLE IF NOT EXISTS deleted_proxy_refs (proxy_id TEXT PRIMARY KEY, site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE, timestamp TEXT NOT NULL)",
    ):
        db.execute(sql)
    columns = {r["name"] for r in db.execute("PRAGMA table_info(errors)")}
    for column in ("proxy_id", "code"):
        if column not in columns:
            db.execute(f"ALTER TABLE errors ADD COLUMN {column} TEXT")
    for table in ("telemetry", "deleted_proxy_refs"):
        columns = {r["name"] for r in db.execute(f"PRAGMA table_info({table})")}
        if "expires_at" not in columns:
            db.execute(f"ALTER TABLE {table} ADD COLUMN expires_at TEXT")
            # Existing receipts retain the originally promised seven-day window.
            db.execute(f"UPDATE {table} SET expires_at=date(substr(timestamp,1,10),'+7 days') || substr(timestamp,11)")
        db.execute(f"CREATE INDEX IF NOT EXISTS {table}_expiry ON {table}(expires_at)")


def utc_now():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def expires(timestamp, days):
    return (datetime.fromisoformat(timestamp.replace("Z", "+00:00")) + timedelta(days=days)).isoformat().replace("+00:00", "Z")


def validate_proxy(db, site_id, proxy_id):
    if proxy_id is None:
        return
    proxy_id = str(proxy_id)
    current = db.execute("SELECT site_id FROM proxies WHERE id=?", (proxy_id,)).fetchone()
    if current is not None:
        valid = current["site_id"] == site_id
    else:
        valid = db.execute("SELECT 1 FROM deleted_proxy_refs WHERE proxy_id=? AND site_id=? AND expires_at>=?", (proxy_id, site_id, utc_now())).fetchone() is not None
    if not valid:
        raise HTTPException(422, "Invalid proxy reference")


def remember_deleted_proxy(db, site_id, proxy_id, timestamp, settings):
    db.execute("DELETE FROM deleted_proxy_refs WHERE expires_at<?", (utc_now(),))
    db.execute("INSERT OR REPLACE INTO deleted_proxy_refs(proxy_id,site_id,timestamp,expires_at) VALUES(?,?,?,?)", (proxy_id, site_id, timestamp, expires(timestamp, settings.retention_days)))
    db.execute("DELETE FROM deleted_proxy_refs WHERE site_id=? AND rowid NOT IN (SELECT rowid FROM deleted_proxy_refs WHERE site_id=? ORDER BY rowid DESC LIMIT ?)", (site_id, site_id, settings.history_site))
    db.execute("DELETE FROM deleted_proxy_refs WHERE rowid NOT IN (SELECT rowid FROM deleted_proxy_refs ORDER BY rowid DESC LIMIT ?)", (settings.history_global,))


def register(app, store, agent, admin, site_row, now):
    settings = app.state.telemetry_settings
    def receive(body, kind, site_id):
        payload = body.model_dump(mode="json")
        encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"))
        digest = hashlib.sha256((kind + encoded).encode()).hexdigest()
        with store.transaction() as db:
            site_row(db, site_id)
            db.execute("DELETE FROM telemetry WHERE expires_at<?", (now(),))
            old = db.execute("SELECT * FROM telemetry WHERE site_id=? AND event_id=?", (site_id, str(body.event_id))).fetchone()
            if old:
                if old["digest"] != digest:
                    raise HTTPException(409, "Event ID already used with different content")
                return {"event_id": str(body.event_id), "duplicate": True, "timestamp": old["timestamp"]}
            if kind == "chat":
                validate_proxy(db, site_id, body.proxy_id)
            if (db.execute("SELECT count(*) FROM telemetry WHERE site_id=?", (site_id,)).fetchone()[0] >= settings.receipts_site
                    or db.execute("SELECT count(*) FROM telemetry").fetchone()[0] >= settings.receipts_global):
                raise HTTPException(429, "Receipt capacity reached; retry later", headers={"Retry-After": "3600"})
            timestamp = now()
            db.execute("INSERT INTO telemetry(site_id,event_id,kind,digest,timestamp,payload,expires_at) VALUES(?,?,?,?,?,?,?)", (site_id, str(body.event_id), kind, digest, timestamp, encoded, expires(timestamp, settings.retention_days)))
            # Payload pruning never removes the deduplication receipt.
            db.execute("UPDATE telemetry SET payload=NULL WHERE site_id=? AND payload IS NOT NULL AND seq NOT IN (SELECT seq FROM telemetry WHERE site_id=? AND payload IS NOT NULL ORDER BY seq DESC LIMIT ?)", (site_id, site_id, settings.history_site))
            db.execute("UPDATE telemetry SET payload=NULL WHERE payload IS NOT NULL AND seq NOT IN (SELECT seq FROM telemetry WHERE payload IS NOT NULL ORDER BY seq DESC LIMIT ?)", (settings.history_global,))
            return {"event_id": str(body.event_id), "duplicate": False, "timestamp": timestamp}

    @app.post("/api/agent/chats")
    def chats(body: Chat, site_id: Annotated[str, Depends(agent)]):
        return receive(body, "chat", site_id)

    @app.post("/api/agent/ai-usage")
    def usage(body: AIUsage, site_id: Annotated[str, Depends(agent)]):
        return receive(body, "ai", site_id)

    def rows(db, site_id, kind):
        return db.execute("SELECT payload,timestamp FROM telemetry WHERE site_id=? AND kind=? AND payload IS NOT NULL AND expires_at>=? ORDER BY seq DESC", (site_id, kind, now())).fetchall()

    @app.get("/api/sites/{site_id}/chats", dependencies=[Depends(admin)])
    def list_chats(site_id: UUID, limit: Annotated[int, Query(ge=1, le=1000)] = 100,
                   offset: Annotated[int, Query(ge=0, le=100000)] = 0):
        with store.transaction() as db:
            site_row(db, str(site_id))
            result = db.execute("SELECT payload,timestamp FROM telemetry WHERE site_id=? AND kind='chat' AND payload IS NOT NULL AND expires_at>=? ORDER BY seq DESC LIMIT ? OFFSET ?", (str(site_id), now(), limit, offset))
            return [{**json.loads(r["payload"]), "site_id": str(site_id), "timestamp": r["timestamp"]} for r in result]

    @app.get("/api/sites/{site_id}/ai-usage", dependencies=[Depends(admin)])
    def ai_summary(site_id: UUID):
        with store.transaction() as db:
            site_row(db, str(site_id))
            groups = {}
            for row in rows(db, str(site_id), "ai"):
                p = json.loads(row["payload"])
                group = groups.setdefault(p["key_id"], {"key_id": p["key_id"], "events": 0, "calls": 0, "error_429": 0, "error_502": 0, "latency_ms": None})
                old_calls = group["calls"]
                for k in ("calls", "error_429", "error_502"):
                    group[k] += p[k]
                group["events"] += 1
                if p["calls"]:
                    # Incremental convex combination avoids latency*calls and
                    # large intermediate sums, even near the float limit.
                    total = group["calls"]
                    previous = group["latency_ms"] or 0
                    sample = p["latency_ms"]
                    mean = previous + (sample - previous) * (p["calls"] / total)
                    group["latency_ms"] = min(max(previous, sample), max(min(previous, sample), mean))
            return {"site_id": str(site_id), "keys": [groups[k] for k in sorted(groups)]}

    @app.get("/api/sites/{site_id}/proxy-health", dependencies=[Depends(admin)])
    def proxy_health(site_id: UUID):
        with store.transaction() as db:
            sid = str(site_id)
            site_row(db, sid)
            current = {r["id"] for r in db.execute("SELECT id FROM proxies WHERE site_id=?", (sid,))}
            groups = {}

            def group(pid):
                return groups.setdefault(pid, {"proxy_id": pid, "current": pid in current, "chats": 0, "links": 0, "converted": 0, "errors": 0, "proxy_blocked": 0, "proxy_recovered": 0, "proxy_auth": 0, "proxy_timeout": 0, "other": 0, "blocked_status": "unknown", "blocked_reported": False})

            for pid in current:
                group(pid)
            for row in rows(db, sid, "chat"):
                p = json.loads(row["payload"])
                if p["proxy_id"]:
                    g = group(p["proxy_id"])
                    g["chats"] += 1
                    g["links"] += p["links"]
                    g["converted"] += int(p["converted"])
            for row in db.execute("SELECT proxy_id,code FROM errors WHERE site_id=? AND proxy_id IS NOT NULL ORDER BY timestamp,rowid", (sid,)):
                g = group(row["proxy_id"])
                g["errors"] += 1
                g[row["code"] or "other"] += 1
                if row["code"] in ("proxy_blocked", "proxy_recovered"):
                    g["blocked_reported"] = row["code"] == "proxy_blocked"
                    g["blocked_status"] = "blocked" if g["blocked_reported"] else "recovered"
            return {"site_id": sid, "proxies": [groups[k] for k in sorted(groups)]}
