"""Version-1 agent API, kept so already-deployed agents keep working.

These routes translate the v1 contract onto v2 storage. They exist only for
agents/sites that have not been moved to the v2 agent; the dashboard is no
longer served from this contract (the v2 dashboard uses /api/*).

Not carried over: nothing. Every v1 agent call maps to a v2 write.
"""

from __future__ import annotations

import json

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from . import configfiles, filesync, ingest, services

router = APIRouter(prefix="/api/agent")


def site_id(request: Request) -> str:
    return request.app.state.auth.site_token(request)


def _now():
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


class V1Worker(BaseModel):
    id: str
    name: str = "worker"
    status: str = "unknown"
    cpu_percent: float = 0
    memory_mb: float = 0
    tasks_completed: int = 0


class V1Heartbeat(BaseModel):
    status: str = "healthy"
    workers: list[V1Worker] = Field(default_factory=list, max_length=500)


@router.post("/heartbeat")
def heartbeat(body: V1Heartbeat, request: Request, sid: str = Depends(site_id)):
    workers = [{"id": w.id, "name": w.name, "status": w.status if w.status in
                ("starting", "running", "idle", "error", "stopped", "unknown") else "unknown",
                "cpu_percent": w.cpu_percent, "memory_mb": w.memory_mb, "tasks_completed": w.tasks_completed,
                "detail": {}} for w in body.workers]
    ingest.handle_presence(request.app, sid, {"workers": workers, "agent_version": "v1", "host": {}})
    site = request.app.state.db.one("SELECT desired_state FROM sites WHERE id=%s", (sid,))
    return {"site_id": sid, "desired_state": site["desired_state"] if site else "stopped", "server_time": _now()}


def _config_file(app, sid):
    row = app.state.db.one("SELECT * FROM site_files WHERE site_id=%s AND path='config.json'", (sid,))
    return row


def _proxies_file(app, sid):
    return app.state.db.one("SELECT * FROM site_files WHERE site_id=%s AND path='proxies.txt'", (sid,))


def _v1_config(app, sid) -> dict:
    row = _config_file(app, sid)
    data = {}
    if row:
        try:
            data = json.loads(filesync.read_text(app, row))
        except (ValueError, TypeError):
            data = {}
    proxies = []
    prow = _proxies_file(app, sid)
    if prow:
        try:
            text = filesync.read_text(app, prow)
            for number, _, entry in configfiles.proxy_lines(text):
                proxies.append({"id": configfiles.proxy_key(entry), "url": configfiles.proxy_url({**entry, "username": "", "password": ""}),
                                "username": entry["username"], "password": entry["password"]})
        except configfiles.FormatError:
            proxies = []
    site = app.state.db.one("SELECT config_revision FROM sites WHERE id=%s", (sid,))
    return {"number_of_workers": int(data.get("number_of_workers", 1) or 0),
            "ai_preset_id": str(data.get("ai_preset_id", "default") or "default"),
            "ai_api_key": str(data.get("ai_api_key", "") or ""), "captcha_api_key": str(data.get("captcha_api_key", "") or ""),
            "proxies": proxies, "revision": site["config_revision"] if site else 0,
            "local_sync_initialized": app.state.db.one(
                "SELECT 1 AS x FROM site_files WHERE site_id=%s LIMIT 1", (sid,)) is not None}


@router.get("/config")
def config(request: Request, sid: str = Depends(site_id)):
    return _v1_config(request.app, sid)


class V1LocalConfig(BaseModel):
    ai_api_key: str = Field(default="", max_length=8192)
    number_of_workers: int = Field(default=1, ge=0, le=1000)
    ai_preset_id: str = Field(default="default", max_length=200)


class V1LocalSync(BaseModel):
    expected_revision: int = 0
    config: V1LocalConfig = Field(default_factory=V1LocalConfig)
    proxies_content: str = Field(default="", max_length=configfiles.MAX_CONTENT)


@router.post("/local-sync")
def local_sync(body: V1LocalSync, request: Request, sid: str = Depends(site_id)):
    app = request.app
    site = app.state.db.one("SELECT * FROM sites WHERE id=%s", (sid,))
    if not site:
        raise HTTPException(404, "Site not found")
    if app.state.db.one("SELECT 1 AS x FROM site_files WHERE site_id=%s LIMIT 1", (sid,)):
        return _v1_config(app, sid)  # hub already owns configuration
    document = {"ai_api_key": body.config.ai_api_key, "number_of_workers": body.config.number_of_workers,
                "ai_preset_id": body.config.ai_preset_id}
    text = json.dumps(document, indent=2) + "\n"
    try:
        configfiles.validate("json", text)
        if body.proxies_content.strip():
            configfiles.validate("proxies", body.proxies_content)
    except configfiles.FormatError as exc:
        raise HTTPException(422, str(exc)) from None
    filesync.agent_push(app, sid, "config.json", "json", text, 0)
    if body.proxies_content.strip():
        filesync.agent_push(app, sid, "proxies.txt", "proxies", body.proxies_content, 0)
    return _v1_config(app, sid)


class V1Error(BaseModel):
    worker_id: str | None = None
    proxy_id: str | None = None
    code: str | None = None
    level: str = "error"
    message: str = Field(min_length=1, max_length=8000)


@router.post("/errors", status_code=201)
def errors(body: V1Error, request: Request, sid: str = Depends(site_id)):
    count = ingest.ingest_logs(request.app, sid, [{"level": {"info": "info", "warning": "warning", "error": "error"}.get(
        body.level, "error"), "message": body.message, "worker_id": body.worker_id, "source": "agent"}])
    return {"id": str(count)}


@router.get("/commands")
def commands(request: Request, sid: str = Depends(site_id)):
    rows = ingest.open_commands(request.app, sid)
    return [{"id": r["command_id"], "action": r["action"], "status": "delivered", "created_at": _now(),
             "completed_at": None, "message": None} for r in rows]


class V1Ack(BaseModel):
    status: str = Field(pattern="^(completed|failed)$")
    message: str | None = Field(default=None, max_length=4000)


@router.post("/commands/{command_id}/ack")
def ack(command_id: str, body: V1Ack, request: Request, sid: str = Depends(site_id)):
    ingest.handle_ack(request.app, sid, {"command_id": command_id, "status": body.status, "message": body.message or ""})
    return {"id": command_id, "status": body.status}


class V1Statistics(BaseModel):
    links_sent_successfully: int = Field(ge=0, le=9007199254740991)
    average_messages_per_chat: float | None = Field(default=None, ge=0, le=1_000_000_000)


@router.post("/statistics")
def statistics(body: V1Statistics, request: Request, sid: str = Depends(site_id)):
    events = [{"name": "links_sent_successfully", "kind": "gauge", "value": body.links_sent_successfully}]
    if body.average_messages_per_chat is not None:
        events.append({"name": "average_messages_per_chat", "kind": "gauge", "value": body.average_messages_per_chat})
    ingest.ingest_metrics(request.app, sid, events)
    return {"site_id": sid, "links_sent_successfully": body.links_sent_successfully,
            "average_messages_per_chat": body.average_messages_per_chat, "updated_at": _now()}


class V1AIUsage(BaseModel):
    event_id: str
    key_id: str = Field(max_length=80)
    calls: int = Field(ge=0, le=9007199254740991)
    error_429: int = Field(default=0, ge=0, le=9007199254740991)
    error_502: int = Field(default=0, ge=0, le=9007199254740991)
    latency_ms: float = Field(default=0, ge=0)


@router.post("/ai-usage")
def ai_usage(body: V1AIUsage, request: Request, sid: str = Depends(site_id)):
    labels = {"key": body.key_id}
    ingest.ingest_metrics(request.app, sid, [
        {"name": "ai.calls", "kind": "count", "value": body.calls, "labels": labels},
        {"name": "ai.error_429", "kind": "count", "value": body.error_429, "labels": labels},
        {"name": "ai.error_502", "kind": "count", "value": body.error_502, "labels": labels},
        {"name": "ai.latency_ms", "kind": "gauge", "value": body.latency_ms, "labels": labels},
    ])
    return {"event_id": body.event_id, "duplicate": False, "timestamp": _now()}


class V1Chat(BaseModel):
    event_id: str
    worker_id: str
    msgs_in: int = 0
    msgs_out: int = 0
    links: int = 0
    converted: bool = False
    duration: float = 0


@router.post("/chats")
def chats(body: V1Chat, request: Request, sid: str = Depends(site_id)):
    ingest.ingest_chats(request.app, sid, [body.model_dump()])
    return {"event_id": body.event_id, "duplicate": False, "timestamp": _now()}


class V1BackupStatus(BaseModel):
    configured: bool = False
    next_backup_at: float | None = None


@router.post("/backup-status")
def backup_status(body: V1BackupStatus, request: Request, sid: str = Depends(site_id)):
    request.app.state.db.execute("UPDATE agent_reports SET backup_state=%s::jsonb WHERE site_id=%s",
                                 (json.dumps({"configured": body.configured, "next_backup_at": body.next_backup_at}), sid))
    return {"ok": True}


@router.get("/backup-config")
def backup_config(request: Request, sid: str = Depends(site_id)):
    from .routers.backups import agent_config
    return agent_config(request)


@router.get("/backup-requests")
def backup_requests(request: Request, sid: str = Depends(site_id)):
    rows = request.app.state.db.query("SELECT id FROM commands WHERE site_id=%s AND action='backup' "
                                      "AND status IN ('pending','delivered')", (sid,))
    return [{"id": str(r["id"]), "source": "on_demand"} for r in rows]


@router.post("/backup-requests/{request_id}/ack")
def backup_request_ack(request_id: str, request: Request, sid: str = Depends(site_id)):
    ingest.handle_ack(request.app, sid, {"command_id": request_id, "status": "failed", "message": "Agent reported failure"})
    return {"ok": True}


@router.post("/backups/upload")
async def backups_upload(request: Request):
    from .routers.backups import agent_upload
    return await agent_upload(request, source="scheduled", command_id=None, size=None)
