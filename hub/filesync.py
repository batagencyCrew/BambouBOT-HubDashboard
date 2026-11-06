"""Revisioned two-way sync of script configuration files.

Model
-----
* The hub stores, per (site, path), the exact file text encrypted, a revision
  number, and the last revision the agent confirmed it wrote (applied_revision).
* Dashboard/bot edits create revision N+1 and notify the agent. The agent pulls,
  writes atomically, and acknowledges with the sha256 it wrote.
* Local edits on the VPS (someone edits .env by hand) are detected by the agent
  comparing the disk hash to the hash it last wrote/pushed. It pushes the new
  text with ``base_revision``. If the hub has not changed since, the local edit
  becomes the next revision. If both sides changed, the hub edit wins on disk
  and the local text is kept in history as ``local-conflict`` so nothing is lost.
"""

from __future__ import annotations

import hashlib
import json

from fastapi import HTTPException

from . import audit, configfiles
from .permissions import Principal


def sha(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


def _scope(site_id: str, path: str) -> str:
    return f"file:{site_id}:{path}"


def read_text(app, row: dict) -> str:
    return app.state.secrets.open(row["sealed"], _scope(str(row["site_id"]), row["path"])) if row["sealed"] else ""


def file_view(app, row: dict, reveal: bool) -> dict:
    text = read_text(app, row)
    try:
        shown = text if reveal else configfiles.mask(row["format"], text, row["secret_keys"])
        parsed = configfiles.describe(row["format"], text, row["secret_keys"], reveal=reveal)
        error = None
    except configfiles.FormatError as exc:
        shown, parsed, error = (text if reveal else ""), None, str(exc)
    return {
        "path": row["path"], "format": row["format"], "revision": row["revision"],
        "applied_revision": row["applied_revision"], "applied_at": row["applied_at"], "apply_error": row["apply_error"],
        "in_sync": row["applied_revision"] >= row["revision"], "sha256": row["sha256"],
        "secret_keys": row["secret_keys"], "updated_at": row["updated_at"], "content": shown,
        "parsed": parsed, "parse_error": error, "revealed": reveal,
    }


def _store(app, cur, site_id: str, path: str, fmt: str, text: str, revision: int, action: str,
           user_id: str | None, summary: dict, secret_keys: list[str], applied: bool):
    sealed = app.state.secrets.seal(text, _scope(site_id, path)) if text else ""
    digest = sha(text)
    cur.execute(
        "INSERT INTO site_files(site_id, path, format, secret_keys, revision, sealed, sha256, applied_revision, updated_by, updated_at) "
        "VALUES(%s,%s,%s,%s,%s,%s,%s,0,%s,now()) ON CONFLICT (site_id, path) DO UPDATE SET format=excluded.format, "
        "secret_keys=excluded.secret_keys, revision=excluded.revision, sealed=excluded.sealed, sha256=excluded.sha256, "
        "apply_error=NULL, updated_by=excluded.updated_by, updated_at=now()",
        (site_id, path, fmt, secret_keys, revision, sealed, digest, user_id))
    if applied:
        cur.execute("UPDATE site_files SET applied_revision=revision, applied_at=now() WHERE site_id=%s AND path=%s",
                    (site_id, path))
    cur.execute("INSERT INTO site_file_history(site_id, path, revision, sealed, sha256, action, changed_by, summary) "
                "VALUES(%s,%s,%s,%s,%s,%s,%s,%s::jsonb)",
                (site_id, path, revision, sealed, digest, action, user_id, json.dumps(summary)))
    cur.execute("UPDATE sites SET config_revision=config_revision+1 WHERE id=%s", (site_id,))


# -- admin edits --------------------------------------------------------------

def admin_write(app, principal: Principal, site: dict, path: str, *, content: str | None = None,
                base_revision: int | None, fmt: str | None = None, patch: dict | None = None,
                secret_keys: list[str] | None = None, request=None, action: str = "update") -> dict:
    path = configfiles.check_path(path)
    site_id = str(site["id"])
    db = app.state.db
    with db.transaction() as cur:
        cur.execute("SELECT * FROM site_files WHERE site_id=%s AND path=%s FOR UPDATE", (site_id, path))
        row = cur.fetchone()
        current_revision = row["revision"] if row else 0
        if base_revision is not None and base_revision != current_revision:
            raise HTTPException(409, f"File changed since revision {base_revision} (now {current_revision}); reload and retry")
        fmt = fmt or (row["format"] if row else configfiles.guess_format(path))
        if fmt not in configfiles.FORMATS:
            raise HTTPException(400, "Unknown format")
        keys = secret_keys if secret_keys is not None else (row["secret_keys"] if row else [])
        old_text = read_text(app, row) if row else None
        try:
            if patch is not None:
                text = configfiles.patch(fmt, old_text or "", **patch)
            else:
                text = configfiles.unmask(fmt, content or "", old_text, keys)
            configfiles.validate(fmt, text)
        except configfiles.FormatError as exc:
            raise HTTPException(400, str(exc)) from None
        if row and text == old_text and keys == row["secret_keys"] and fmt == row["format"]:
            return file_view(app, row, False)
        summary = configfiles.diff_keys(fmt, old_text, text)
        _store(app, cur, site_id, path, fmt, text, current_revision + 1, action, principal.user_id, summary, keys, applied=False)
        cur.execute("SELECT * FROM site_files WHERE site_id=%s AND path=%s", (site_id, path))
        row = cur.fetchone()
    audit.record(db, principal, f"file.{action}", site_id=site_id, target=path,
                 detail={"revision": row["revision"], **summary}, request=request)
    notify(app, site_id)
    # Writes always answer with the masked view; revealing is an explicit, audited read.
    return file_view(app, row, False)


def notify(app, site_id: str):
    app.state.realtime.send_site(site_id, {"type": "files_changed"})


def restore(app, principal: Principal, site: dict, path: str, revision: int, request=None) -> dict:
    db = app.state.db
    history = db.one("SELECT * FROM site_file_history WHERE site_id=%s AND path=%s AND revision=%s ORDER BY id DESC LIMIT 1",
                     (site["id"], path, revision))
    if not history:
        raise HTTPException(404, "Revision not found")
    text = app.state.secrets.open(history["sealed"], _scope(str(site["id"]), path)) if history["sealed"] else ""
    return admin_write(app, principal, site, path, content=text, base_revision=None, request=request, action="restore")


# -- agent side ---------------------------------------------------------------

def agent_files(app, site_id: str) -> list[dict]:
    rows = app.state.db.query("SELECT * FROM site_files WHERE site_id=%s ORDER BY path", (site_id,))
    return [{"path": r["path"], "format": r["format"], "revision": r["revision"], "sha256": r["sha256"],
             "content": read_text(app, r), "applied_revision": r["applied_revision"]} for r in rows]


def agent_ack(app, site_id: str, path: str, revision: int, digest: str, error: str | None):
    db = app.state.db
    if error:
        db.execute("UPDATE site_files SET apply_error=%s WHERE site_id=%s AND path=%s", (error[:1000], site_id, path))
        return {"ok": False}
    row = db.one("SELECT revision, sha256 FROM site_files WHERE site_id=%s AND path=%s", (site_id, path))
    if not row:
        raise HTTPException(404, "File not managed")
    if revision > row["revision"]:
        raise HTTPException(409, "Unknown revision")
    if revision == row["revision"] and digest != row["sha256"]:
        raise HTTPException(409, "Written content does not match the hub revision")
    db.execute("UPDATE site_files SET applied_revision=GREATEST(applied_revision, %s), applied_at=now(), apply_error=NULL "
               "WHERE site_id=%s AND path=%s", (revision, site_id, path))
    return {"ok": True}


def agent_push(app, site_id: str, path: str, fmt: str | None, text: str, base_revision: int,
               secret_keys: list[str] | None = None) -> dict:
    """The VPS copy changed locally (or is being enrolled for the first time)."""
    try:
        path = configfiles.check_path(path)
        fmt = fmt or configfiles.guess_format(path)
        configfiles.validate(fmt, text)
    except configfiles.FormatError as exc:
        raise HTTPException(422, f"{path}: {exc}") from None
    db = app.state.db
    with db.transaction() as cur:
        cur.execute("SELECT * FROM site_files WHERE site_id=%s AND path=%s FOR UPDATE", (site_id, path))
        row = cur.fetchone()
        current = row["revision"] if row else 0
        old_text = read_text(app, row) if row else None
        keys = row["secret_keys"] if row else (secret_keys or [])
        if row and text == old_text:
            cur.execute("UPDATE site_files SET applied_revision=revision, applied_at=now(), apply_error=NULL "
                        "WHERE site_id=%s AND path=%s", (site_id, path))
            return {"accepted": True, "revision": current, "conflict": False}
        if base_revision != current:
            # Hub has newer content the agent has not applied yet: keep the local
            # text for the record and tell the agent to pull the hub revision.
            sealed = app.state.secrets.seal(text, _scope(site_id, path)) if text else ""
            cur.execute("INSERT INTO site_file_history(site_id, path, revision, sealed, sha256, action, summary) "
                        "VALUES(%s,%s,%s,%s,%s,'local-conflict',%s::jsonb)",
                        (site_id, path, current, sealed, sha(text),
                         json.dumps(configfiles.diff_keys(fmt, old_text, text))))
            return {"accepted": False, "revision": current, "conflict": True}
        summary = configfiles.diff_keys(fmt, old_text, text)
        _store(app, cur, site_id, path, fmt, text, current + 1, "initial" if not row else "local-change",
               None, summary, keys, applied=True)
    audit.record(db, None, "file.local_change" if row else "file.enroll", site_id=site_id, target=path,
                 detail={"revision": current + 1, **summary})
    app.state.realtime.publish({"type": "file", "site_id": site_id, "path": path, "revision": current + 1, "origin": "vps"})
    return {"accepted": True, "revision": current + 1, "conflict": False}
