"""Agent API (site token). The agent prefers the WebSocket at /ws/site for push,
but every operation is also available over plain HTTP so a minimal integration
(or an agent behind a proxy that blocks WebSockets) still works.
"""

from __future__ import annotations

import json

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from .. import filesync, ingest

router = APIRouter(prefix="/api/agent/v2")


def site_id(request: Request) -> str:
    return request.app.state.auth.site_token(request)


class Batch(BaseModel):
    """One envelope for everything the SDK buffered since its last flush."""
    presence: dict | None = None
    logs: list[dict] = Field(default_factory=list, max_length=5000)
    metrics: list[dict] = Field(default_factory=list, max_length=5000)
    costs: list[dict] = Field(default_factory=list, max_length=5000)
    balances: list[dict] = Field(default_factory=list, max_length=500)
    proxies: list[dict] = Field(default_factory=list, max_length=5000)
    issues: list[dict] = Field(default_factory=list, max_length=200)
    acks: list[dict] = Field(default_factory=list, max_length=200)


@router.post("/batch")
def batch(body: Batch, request: Request, sid: str = Depends(site_id)):
    app = request.app
    result = {}
    if body.presence is not None:
        ingest.handle_presence(app, sid, body.presence)
        if body.presence.get("capabilities"):
            _capabilities(app, sid, body.presence["capabilities"])
    if body.logs:
        result["logs"] = ingest.ingest_logs(app, sid, body.logs)
    if body.metrics:
        result["metrics"] = ingest.ingest_metrics(app, sid, body.metrics)
    if body.costs:
        result["costs"] = ingest.ingest_costs(app, sid, body.costs)
    if body.balances:
        result["balances"] = ingest.ingest_balances(app, sid, body.balances)
    if body.proxies:
        result["proxies"] = ingest.ingest_proxies(app, sid, body.proxies)
    if body.issues:
        result["issues"] = [ingest.raise_issue(app, sid, i) for i in body.issues[:200]]
    for ack in body.acks:
        ingest.handle_ack(app, sid, ack)
    return {"accepted": result, **ingest.presence_reply(app, sid)}


def _capabilities(app, sid: str, caps: dict):
    commands = caps.get("commands") if isinstance(caps.get("commands"), list) else []
    files = caps.get("files") if isinstance(caps.get("files"), list) else []
    clean_commands = [{"name": str(c.get("name", ""))[:60], "description": str(c.get("description", ""))[:300],
                       "args": c.get("args") if isinstance(c.get("args"), dict) else {}}
                      for c in commands[:100] if isinstance(c, dict) and c.get("name")]
    clean_files = [{"path": str(f.get("path", ""))[:300], "format": str(f.get("format", ""))[:20]}
                   for f in files[:50] if isinstance(f, dict) and f.get("path")]
    app.state.db.execute(
        "INSERT INTO site_capabilities(site_id, commands, files, sdk, updated_at) VALUES(%s,%s::jsonb,%s::jsonb,%s,now()) "
        "ON CONFLICT (site_id) DO UPDATE SET commands=excluded.commands, files=excluded.files, sdk=excluded.sdk, updated_at=now()",
        (sid, json.dumps(clean_commands), json.dumps(clean_files), str(caps.get("sdk", ""))[:80]))


@router.get("/commands")
def commands(request: Request, sid: str = Depends(site_id)):
    return ingest.open_commands(request.app, sid)


class Ack(BaseModel):
    status: str = Field(pattern="^(running|completed|failed)$")
    message: str = Field(default="", max_length=4000)


@router.post("/commands/{command_id}/ack")
def ack(command_id: str, body: Ack, request: Request, sid: str = Depends(site_id)):
    ingest.handle_ack(request.app, sid, {"command_id": command_id, "status": body.status, "message": body.message})
    return {"ok": True}


# -- files ----------------------------------------------------------------------

@router.get("/files")
def files(request: Request, sid: str = Depends(site_id)):
    return {"files": filesync.agent_files(request.app, sid)}


class FileAck(BaseModel):
    path: str = Field(max_length=300)
    revision: int
    sha256: str = Field(max_length=64)
    error: str | None = Field(default=None, max_length=1000)


@router.post("/files/ack")
def file_ack(body: FileAck, request: Request, sid: str = Depends(site_id)):
    return filesync.agent_ack(request.app, sid, body.path, body.revision, body.sha256, body.error)


class FilePush(BaseModel):
    path: str = Field(max_length=300)
    format: str | None = None
    content: str = Field(max_length=1024 * 1024)
    base_revision: int = 0
    secret_keys: list[str] = Field(default_factory=list, max_length=200)


@router.post("/files/push")
def file_push(body: FilePush, request: Request, sid: str = Depends(site_id)):
    return filesync.agent_push(request.app, sid, body.path, body.format, body.content, body.base_revision, body.secret_keys)


@router.get("/whoami")
def whoami(request: Request, sid: str = Depends(site_id)):
    row = request.app.state.db.one("SELECT id, slug, name, desired_state FROM sites WHERE id=%s", (sid,))
    if not row:
        raise HTTPException(404, "Site not found")
    return {"site_id": str(row["id"]), "slug": row["slug"], "name": row["name"], "desired_state": row["desired_state"]}
