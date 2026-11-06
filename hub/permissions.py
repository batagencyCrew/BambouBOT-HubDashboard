"""Role/permission model shared by the dashboard API, bots, and agent surface.

Permissions are strings of the form ``resource:action``. A user's effective set
is the union of their role defaults and their explicit extra grants. Access to a
particular site additionally requires that the site is inside the user's scope.
"""

from __future__ import annotations

from dataclasses import dataclass

ALL_SITES = "*"

# Every permission the hub understands. New features must register theirs here;
# unknown strings are rejected at user-creation time.
PERMISSIONS: dict[str, str] = {
    "sites:view": "See sites, workers, logs, metrics, costs, proxies and backups",
    "sites:create": "Add sites and issue agent tokens",
    "sites:edit": "Rename sites and change site metadata",
    "sites:delete": "Delete sites and their data",
    "control:lifecycle": "Start, stop and restart a site's script",
    "control:pause": "Pause and resume a site's script",
    "control:workers": "Change a site's worker count",
    "control:custom": "Send script-defined custom commands",
    "config:edit": "Edit a site's configuration files",
    "config:preview": "Dry-run configuration file changes",
    "secrets:reveal": "View decrypted secret values in config files",
    "proxies:manage": "Add, import and delete proxies",
    "backups:request": "Request an immediate backup",
    "backups:manage": "Configure backup schedules and destinations; restore files",
    "backups:download": "Download backup archives",
    "users:manage": "Create, edit and disable users",
    "users:audit": "View the audit log",
    "alerts:manage": "Create and edit alert rules",
    "alerts:ack": "Acknowledge, mute and resolve alerts",
    "bots:manage": "Link bot accounts and set bot defaults",
}

ROLE_DEFAULTS: dict[str, set[str]] = {
    "owner": set(PERMISSIONS),
    "admin": set(PERMISSIONS) - {"sites:delete", "users:manage"},
    "operator": {
        "sites:view", "control:lifecycle", "control:pause", "control:workers",
        "control:custom", "config:edit", "config:preview", "proxies:manage",
        "backups:request", "backups:download", "alerts:ack",
    },
    "viewer": {"sites:view"},
}

ROLES = tuple(ROLE_DEFAULTS)


@dataclass(frozen=True)
class Principal:
    user_id: str | None
    username: str
    role: str
    permissions: frozenset[str]
    site_scope: tuple[str, ...] | None  # None = every site
    source: str = "dashboard"           # dashboard | bot | api | system
    bot_platform: str | None = None
    bot_user: str | None = None

    def can(self, permission: str) -> bool:
        return permission in self.permissions

    def can_site(self, permission: str, site_id: str) -> bool:
        if not self.can(permission):
            return False
        return self.site_scope is None or site_id in self.site_scope

    def visible_site(self, site_id: str) -> bool:
        return self.site_scope is None or site_id in self.site_scope


SYSTEM = Principal(None, "system", "owner", frozenset(PERMISSIONS), None, source="system")


def effective_permissions(role: str, extra: list[str] | None = None) -> frozenset[str]:
    if role not in ROLE_DEFAULTS:
        raise ValueError(f"Unknown role: {role}")
    unknown = set(extra or []) - set(PERMISSIONS)
    if unknown:
        raise ValueError(f"Unknown permissions: {', '.join(sorted(unknown))}")
    return frozenset(ROLE_DEFAULTS[role] | set(extra or []))


def resolve_scope(scope: list[str] | None) -> tuple[str, ...] | None:
    if not scope or ALL_SITES in scope:
        return None
    return tuple(scope)
