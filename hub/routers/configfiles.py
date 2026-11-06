from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from .. import audit, configfiles, filesync, services
from ..auth import require
from ..permissions import Principal

router = APIRouter(prefix="/api/sites/{site_ref}/files")


class FileWrite(BaseModel):
    content: str = Field(max_length=configfiles.MAX_CONTENT)
    base_revision: int | None = None
    format: str | None = None
    secret_keys: list[str] | None = Field(default=None, max_length=200)


class FilePatch(BaseModel):
    base_revision: int | None = None
    set: dict = Field(default_factory=dict)
    delete: list[str] = Field(default_factory=list, max_length=500)
    add_proxies: list[str] = Field(default_factory=list, max_length=5000)
    remove_proxies: list[str] = Field(default_factory=list, max_length=5000)


class FileCreate(BaseModel):
    path: str = Field(max_length=300)
    format: str | None = None
    content: str = Field(default="", max_length=configfiles.MAX_CONTENT)
    secret_keys: list[str] = Field(default_factory=list, max_length=200)


@router.get("")
def list_files(site_ref: str, request: Request, principal: Principal = Depends(require("sites:view"))):
    db = request.app.state.db
    site = services.resolve_site(db, principal, site_ref)
    rows = db.query("SELECT path, format, revision, applied_revision, applied_at, apply_error, updated_at, sha256 "
                    "FROM site_files WHERE site_id=%s ORDER BY path", (site["id"],))
    return [{**r, "in_sync": r["applied_revision"] >= r["revision"]} for r in rows]


@router.post("", status_code=201)
def create_file(site_ref: str, body: FileCreate, request: Request, principal: Principal = Depends(require("config:edit"))):
    db = request.app.state.db
    site = services.resolve_site(db, principal, site_ref, "config:edit")
    try:
        configfiles.check_path(body.path)
    except configfiles.FormatError as exc:
        raise HTTPException(400, str(exc)) from None
    if db.one("SELECT 1 AS x FROM site_files WHERE site_id=%s AND path=%s", (site["id"], body.path)):
        raise HTTPException(409, "File already managed")
    return filesync.admin_write(request.app, principal, site, body.path, content=body.content, base_revision=0,
                                fmt=body.format, secret_keys=body.secret_keys, request=request, action="create")


def _row(db, site, path):
    row = db.one("SELECT * FROM site_files WHERE site_id=%s AND path=%s", (site["id"], path))
    if not row:
        raise HTTPException(404, "File not managed for this site")
    return row


@router.get("/content")
def get_file(site_ref: str, path: str, request: Request, reveal: bool = False,
             principal: Principal = Depends(require("sites:view"))):
    db = request.app.state.db
    site = services.resolve_site(db, principal, site_ref)
    if reveal and not principal.can_site("secrets:reveal", str(site["id"])):
        raise HTTPException(403, "Missing permission: secrets:reveal")
    row = _row(db, site, path)
    if reveal:
        audit.record(db, principal, "file.reveal", site_id=str(site["id"]), target=path, request=request)
    return filesync.file_view(request.app, row, reveal)


@router.put("/content")
def put_file(site_ref: str, path: str, body: FileWrite, request: Request,
             principal: Principal = Depends(require("config:edit"))):
    db = request.app.state.db
    site = services.resolve_site(db, principal, site_ref, "config:edit")
    _row(db, site, path)
    return filesync.admin_write(request.app, principal, site, path, content=body.content,
                                base_revision=body.base_revision, fmt=body.format, secret_keys=body.secret_keys,
                                request=request)


@router.patch("/content")
def patch_file(site_ref: str, path: str, body: FilePatch, request: Request,
               principal: Principal = Depends(require("config:edit"))):
    db = request.app.state.db
    site = services.resolve_site(db, principal, site_ref, "config:edit")
    row = _row(db, site, path)
    if row["format"] in ("proxies", "proxy-json") and not principal.can_site("proxies:manage", str(site["id"])) \
            and (body.add_proxies or body.remove_proxies):
        raise HTTPException(403, "Missing permission: proxies:manage")
    return filesync.admin_write(request.app, principal, site, path, base_revision=body.base_revision,
                                patch={"set_values": body.set, "delete": body.delete,
                                       "add_proxies": body.add_proxies, "remove_proxies": body.remove_proxies},
                                request=request)


@router.post("/validate")
def validate(site_ref: str, path: str, body: FileWrite, request: Request,
             principal: Principal = Depends(require("sites:view"))):
    db = request.app.state.db
    site = services.resolve_site(db, principal, site_ref)
    row = db.one("SELECT * FROM site_files WHERE site_id=%s AND path=%s", (site["id"], path))
    fmt = body.format or (row["format"] if row else configfiles.guess_format(path))
    old = filesync.read_text(request.app, row) if row else None
    try:
        text = configfiles.unmask(fmt, body.content, old, row["secret_keys"] if row else [])
        configfiles.validate(fmt, text)
    except configfiles.FormatError as exc:
        return {"valid": False, "error": str(exc)}
    return {"valid": True, "changes": configfiles.diff_keys(fmt, old, text)}


@router.delete("")
def unmanage(site_ref: str, path: str, request: Request, principal: Principal = Depends(require("config:edit"))):
    """Stop managing a file (the VPS copy is left as-is)."""
    db = request.app.state.db
    site = services.resolve_site(db, principal, site_ref, "config:edit")
    if not db.execute("DELETE FROM site_files WHERE site_id=%s AND path=%s", (site["id"], path)):
        raise HTTPException(404, "File not managed")
    audit.record(db, principal, "file.unmanage", site_id=str(site["id"]), target=path, request=request)
    filesync.notify(request.app, str(site["id"]))
    return {"ok": True}


@router.get("/history")
def history(site_ref: str, path: str, request: Request, principal: Principal = Depends(require("sites:view"))):
    db = request.app.state.db
    site = services.resolve_site(db, principal, site_ref)
    rows = db.query("SELECT h.id, h.revision, h.action, h.changed_at, h.summary, h.sha256, u.username "
                    "FROM site_file_history h LEFT JOIN users u ON u.id=h.changed_by "
                    "WHERE h.site_id=%s AND h.path=%s ORDER BY h.id DESC LIMIT 200", (site["id"], path))
    return rows


@router.get("/history/{history_id}")
def history_content(site_ref: str, path: str, history_id: int, request: Request, reveal: bool = False,
                    principal: Principal = Depends(require("sites:view"))):
    db = request.app.state.db
    site = services.resolve_site(db, principal, site_ref)
    if reveal and not principal.can_site("secrets:reveal", str(site["id"])):
        raise HTTPException(403, "Missing permission: secrets:reveal")
    row = db.one("SELECT h.*, f.format, f.secret_keys FROM site_file_history h JOIN site_files f "
                 "ON f.site_id=h.site_id AND f.path=h.path WHERE h.id=%s AND h.site_id=%s AND h.path=%s",
                 (history_id, site["id"], path))
    if not row:
        raise HTTPException(404, "History entry not found")
    text = request.app.state.secrets.open(row["sealed"], f"file:{site['id']}:{path}") if row["sealed"] else ""
    if reveal:
        audit.record(db, principal, "file.reveal_history", site_id=str(site["id"]), target=f"{path}@{row['revision']}",
                     request=request)
    else:
        try:
            text = configfiles.mask(row["format"], text, row["secret_keys"])
        except configfiles.FormatError:
            text = ""
    return {"id": row["id"], "revision": row["revision"], "action": row["action"], "content": text}


@router.post("/restore")
def restore(site_ref: str, path: str, revision: int, request: Request, principal: Principal = Depends(require("config:edit"))):
    db = request.app.state.db
    site = services.resolve_site(db, principal, site_ref, "config:edit")
    return filesync.restore(request.app, principal, site, path, revision, request)
