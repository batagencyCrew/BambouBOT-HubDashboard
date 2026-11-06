"""Append-only audit trail for every state-changing action."""

from __future__ import annotations

import json

from fastapi import Request

from .permissions import Principal


def record(db, principal: Principal | None, action: str, *,
           site_id: str | None = None, target: str | None = None,
           detail: dict | None = None, request: Request | None = None) -> None:
    actor = principal.username if principal else "system"
    source = principal.source if principal else "system"
    ip = ""
    if request is not None and request.client:
        ip = request.client.host[:64]
    db.execute(
        "INSERT INTO audit_log(user_id, actor, source, action, site_id, target, detail, ip) "
        "VALUES(%s,%s,%s,%s,%s,%s,%s::jsonb,%s)",
        (principal.user_id if principal else None, actor, source, action, site_id, target,
         json.dumps(detail or {}, default=str), ip))
