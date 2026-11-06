from __future__ import annotations

import asyncio
import queue
import threading

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from .. import audit, services
from ..auth import require
from ..backups import FOLDER, REMOTE_NAME, BackupRejected
from ..permissions import Principal

router = APIRouter(prefix="/api")


def svc(request: Request):
    return request.app.state.backups


class Destination(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    remote: str = Field(pattern=REMOTE_NAME.pattern)
    folder: str = Field(default="", max_length=500)
    enabled: bool = True


class SiteBackupConfig(BaseModel):
    enabled: bool
    interval_minutes: int = Field(ge=15, le=43200)
    destination_ids: list[str] = Field(default_factory=list, max_length=20)
    keep_count: int = Field(default=14, ge=1, le=365)
    exclude_files: list[str] = Field(default_factory=list, max_length=200)


def _dest_view(row):
    return {**row, "id": str(row["id"])}


@router.get("/backup-remotes")
def remotes(request: Request, principal: Principal = Depends(require("backups:manage"))):
    return {"remotes": svc(request).rclone.remotes()}


@router.get("/backup-destinations")
def destinations(request: Request, principal: Principal = Depends(require("sites:view"))):
    return [_dest_view(r) for r in request.app.state.db.query("SELECT * FROM backup_destinations ORDER BY name")]


def _check_destination(request, body: Destination):
    if body.folder and not FOLDER.match(body.folder.strip("/")):
        raise HTTPException(400, "Folder may contain letters, digits, space, dot, dash, underscore and '/'")
    remotes = svc(request).rclone.remotes()
    if body.remote not in remotes:
        raise HTTPException(400, f"rclone remote '{body.remote}' is not configured on the hub")


@router.post("/backup-destinations", status_code=201)
def add_destination(body: Destination, request: Request, principal: Principal = Depends(require("backups:manage"))):
    _check_destination(request, body)
    db = request.app.state.db
    row = db.one("INSERT INTO backup_destinations(name, remote, folder, enabled) VALUES(%s,%s,%s,%s) RETURNING *",
                 (body.name, body.remote, body.folder.strip("/"), body.enabled))
    audit.record(db, principal, "backup.destination_create", target=body.name, detail=body.model_dump(), request=request)
    return _dest_view(row)


@router.put("/backup-destinations/{dest_id}")
def update_destination(dest_id: str, body: Destination, request: Request, principal: Principal = Depends(require("backups:manage"))):
    _check_destination(request, body)
    db = request.app.state.db
    row = db.one("UPDATE backup_destinations SET name=%s, remote=%s, folder=%s, enabled=%s WHERE id=%s RETURNING *",
                 (body.name, body.remote, body.folder.strip("/"), body.enabled, dest_id))
    if not row:
        raise HTTPException(404, "Destination not found")
    audit.record(db, principal, "backup.destination_update", target=body.name, detail=body.model_dump(), request=request)
    return _dest_view(row)


@router.delete("/backup-destinations/{dest_id}")
def delete_destination(dest_id: str, request: Request, principal: Principal = Depends(require("backups:manage"))):
    db = request.app.state.db
    if db.one("SELECT 1 AS x FROM site_backup_config WHERE %s::uuid = ANY(destination_ids)", (dest_id,)):
        raise HTTPException(409, "Destination is used by a site; remove it there first")
    row = db.one("DELETE FROM backup_destinations WHERE id=%s RETURNING name", (dest_id,))
    if not row:
        raise HTTPException(404, "Destination not found")
    audit.record(db, principal, "backup.destination_delete", target=row["name"], request=request)
    return {"ok": True}


@router.get("/sites/{site_ref}/backups/config")
def get_config(site_ref: str, request: Request, principal: Principal = Depends(require("sites:view"))):
    db = request.app.state.db
    site = services.resolve_site(db, principal, site_ref)
    row = db.one("SELECT * FROM site_backup_config WHERE site_id=%s", (site["id"],))
    report = db.one("SELECT backup_state FROM agent_reports WHERE site_id=%s", (site["id"],))
    return {**(row or {}), "site_id": str(site["id"]), "destination_ids": [str(d) for d in (row or {}).get("destination_ids", [])],
            "agent": report["backup_state"] if report else {}}


@router.put("/sites/{site_ref}/backups/config")
def put_config(site_ref: str, body: SiteBackupConfig, request: Request, principal: Principal = Depends(require("backups:manage"))):
    db = request.app.state.db
    site = services.resolve_site(db, principal, site_ref, "backups:manage")
    if body.enabled and not body.destination_ids:
        raise HTTPException(400, "Choose at least one destination to enable scheduled backups")
    if body.destination_ids:
        found = db.query("SELECT id FROM backup_destinations WHERE id = ANY(%s::uuid[])", (body.destination_ids,))
        if len(found) != len(set(body.destination_ids)):
            raise HTTPException(400, "Unknown destination")
    excludes = body.exclude_files or ['.git', 'node_modules', '__pycache__', '.venv', 'venv']
    db.execute("INSERT INTO site_backup_config(site_id, enabled, interval_minutes, destination_ids, keep_count, exclude_files, updated_at) "
               "VALUES(%s,%s,%s,%s::uuid[],%s,%s,now()) ON CONFLICT (site_id) DO UPDATE SET enabled=excluded.enabled, "
               "interval_minutes=excluded.interval_minutes, destination_ids=excluded.destination_ids, keep_count=excluded.keep_count, "
               "exclude_files=excluded.exclude_files, updated_at=now()",
               (site["id"], body.enabled, body.interval_minutes, body.destination_ids, body.keep_count, excludes))
    audit.record(db, principal, "backup.config", site_id=str(site["id"]), detail=body.model_dump(), request=request)
    request.app.state.realtime.send_site(str(site["id"]), {"type": "backup_config_changed"})
    return get_config(site_ref, request, principal)


@router.post("/sites/{site_ref}/backups/request", status_code=202)
def request_backup(site_ref: str, request: Request, principal: Principal = Depends(require("backups:request"))):
    db = request.app.state.db
    site = services.resolve_site(db, principal, site_ref, "backups:request")
    row = db.one("INSERT INTO commands(site_id, action, args, requested_by, source) VALUES(%s,'backup','{}'::jsonb,%s,%s) RETURNING *",
                 (site["id"], principal.user_id, principal.source))
    delivered = request.app.state.realtime.send_command(str(site["id"]), {"command_id": str(row["id"]), "action": "backup", "args": {}})
    if delivered:
        db.execute("UPDATE commands SET status='delivered', delivered_at=now() WHERE id=%s", (row["id"],))
    audit.record(db, principal, "backup.request", site_id=str(site["id"]), request=request)
    return {"command_id": str(row["id"]), "agent_online": delivered}


@router.get("/sites/{site_ref}/backups")
def list_backups(site_ref: str, request: Request, limit: int = Query(default=50, ge=1, le=500),
                 principal: Principal = Depends(require("sites:view"))):
    db = request.app.state.db
    site = services.resolve_site(db, principal, site_ref)
    rows = db.query("SELECT b.*, f.local_available FROM backups b LEFT JOIN backup_files f ON f.backup_id=b.id "
                    "WHERE b.site_id=%s ORDER BY b.created_at DESC LIMIT %s", (site["id"], limit))
    ids = [r["id"] for r in rows]
    transfers = db.query("SELECT t.*, d.name AS destination FROM backup_transfers t JOIN backup_destinations d ON d.id=t.destination_id "
                         "WHERE t.backup_id = ANY(%s::uuid[]) ORDER BY d.name", (ids,))
    by_backup: dict = {}
    for t in transfers:
        by_backup.setdefault(t["backup_id"], []).append({"destination": t["destination"], "status": t["status"],
                                                          "attempts": t["attempts"], "error": t["error"],
                                                          "remote_path": t["remote_path"], "completed_at": t["completed_at"]})
    return [{**r, "id": str(r["id"]), "site_id": str(r["site_id"]), "local_available": bool(r["local_available"]),
             "transfers": by_backup.get(r["id"], [])} for r in rows]


def _backup(db, principal, site_ref, backup_id, permission):
    site = services.resolve_site(db, principal, site_ref, permission)
    row = db.one("SELECT b.*, f.stored_path, f.local_available FROM backups b LEFT JOIN backup_files f ON f.backup_id=b.id "
                 "WHERE b.id=%s AND b.site_id=%s", (backup_id, site["id"]))
    if not row:
        raise HTTPException(404, "Backup not found")
    return site, row


@router.post("/sites/{site_ref}/backups/{backup_id}/retry")
def retry(site_ref: str, backup_id: str, request: Request, principal: Principal = Depends(require("backups:manage"))):
    db = request.app.state.db
    site, row = _backup(db, principal, site_ref, backup_id, "backups:manage")
    if not row["local_available"]:
        raise HTTPException(409, "The hub no longer holds this archive; request a new backup")
    count = svc(request).retry(row["id"])
    audit.record(db, principal, "backup.retry", site_id=str(site["id"]), target=str(row["id"]), request=request)
    return {"requeued": count}


@router.get("/sites/{site_ref}/backups/{backup_id}/download")
def download(site_ref: str, backup_id: str, request: Request, principal: Principal = Depends(require("backups:download"))):
    db = request.app.state.db
    site, row = _backup(db, principal, site_ref, backup_id, "backups:download")
    path = svc(request).root / (row["stored_path"] or "")
    if not row["local_available"] or not path.is_file():
        raise HTTPException(410, "Archive is no longer cached on the hub; download it from the cloud destination")
    audit.record(db, principal, "backup.download", site_id=str(site["id"]), target=row["filename"], request=request)
    return FileResponse(path, filename=row["filename"], media_type="application/gzip")


# -- agent upload ------------------------------------------------------------------

@router.get("/agent/v2/backups/config")
def agent_config(request: Request):
    sid = request.app.state.auth.site_token(request)
    db = request.app.state.db
    row = db.one("SELECT * FROM site_backup_config WHERE site_id=%s", (sid,))
    last = db.one("SELECT max(created_at) AS ts FROM backups WHERE site_id=%s AND status IN ('uploaded','completed','partial')", (sid,))
    return {"enabled": bool(row and row["enabled"]), "interval_minutes": row["interval_minutes"] if row else 1440,
            "exclude": list(row["exclude_files"]) if row else [], "last_backup_at": last["ts"] if last else None,
            "max_bytes": svc(request).max_upload}


@router.post("/agent/v2/backups/upload")
async def agent_upload(request: Request, source: str = Query(pattern="^(scheduled|manual|pre_change)$"),
                       command_id: str | None = None, size: int | None = None):
    app = request.app
    sid = await asyncio.to_thread(app.state.auth.site_token, request)
    site = await asyncio.to_thread(app.state.db.one, "SELECT * FROM sites WHERE id=%s", (sid,))
    service = app.state.backups
    try:
        backup = await asyncio.to_thread(service.begin, site, source, size)
    except BackupRejected as exc:
        raise HTTPException(exc.status, exc.message) from None
    # Bridge the async request body to the sync writer through a bounded queue.
    chunks: queue.Queue = queue.Queue(maxsize=32)
    result: dict = {}

    def consume():
        def iterator():
            while True:
                item = chunks.get()
                if item is None:
                    return
                if isinstance(item, BaseException):
                    raise item
                yield item
        try:
            result["backup"] = service.receive(backup, iterator())
        except BaseException as exc:  # surfaced below
            result["error"] = exc

    worker = threading.Thread(target=consume, daemon=True)
    worker.start()
    try:
        async for chunk in request.stream():
            if chunk:
                while True:
                    try:
                        chunks.put_nowait(chunk)
                        break
                    except queue.Full:
                        if not worker.is_alive():
                            break
                        await asyncio.sleep(0.01)
            if not worker.is_alive():
                break
        if worker.is_alive():
            chunks.put(None)
    except BaseException:
        if worker.is_alive():
            chunks.put(ConnectionError("Client disconnected"))
        raise
    await asyncio.to_thread(worker.join)
    error = result.get("error")
    if isinstance(error, BackupRejected):
        raise HTTPException(error.status, error.message)
    if error:
        raise HTTPException(500, "Upload failed")
    if command_id:
        from ..ingest import handle_ack
        await asyncio.to_thread(handle_ack, app, sid, {"command_id": command_id, "status": "completed",
                                                       "message": f"Uploaded {result['backup']['filename']}"})
    b = result["backup"]
    return {"backup_id": str(b["id"]), "filename": b["filename"], "size_bytes": b["size_bytes"], "sha256": b["sha256"],
            "status": b["status"]}
