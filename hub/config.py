"""Runtime configuration read once at startup. Secrets never have defaults."""

import os
import secrets
from dataclasses import dataclass, field
from pathlib import Path


def _int(name: str, default: int, minimum: int = 0, maximum: int = 2**31 - 1) -> int:
    raw = os.environ.get(name, str(default))
    if not raw.isdigit() or not minimum <= int(raw) <= maximum:
        raise RuntimeError(f"{name} must be an integer between {minimum} and {maximum}")
    return int(raw)


def _bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    if raw.lower() not in ("0", "1", "false", "true", "no", "yes"):
        raise RuntimeError(f"{name} must be a boolean")
    return raw.lower() in ("1", "true", "yes")


@dataclass(frozen=True)
class Settings:
    database_url: str = field(repr=False)
    data_dir: Path
    secret_key: bytes = field(repr=False)
    session_ttl: int = 12 * 60 * 60
    secure_cookies: bool = True
    max_request_bytes: int = 4 * 1024 * 1024
    max_backup_upload_bytes: int = 4 * 1024**3
    rclone_binary: str = "rclone"
    rclone_config: str | None = None
    frontend_dir: Path | None = None
    bootstrap_owner: str | None = None
    bootstrap_password: str | None = field(default=None, repr=False)
    background_tasks: bool = True
    log_ingest_batch: int = 5000
    bot_stream_queue: int = 1000

    @classmethod
    def from_env(cls, **overrides) -> "Settings":
        database_url = overrides.pop("database_url", None) or os.environ.get("HUB_DATABASE_URL", "")
        if not database_url.startswith(("postgresql://", "postgres://")):
            raise RuntimeError("HUB_DATABASE_URL must be a postgresql:// connection string")
        data_dir = Path(overrides.pop("data_dir", None) or os.environ.get("HUB_DATA_DIR", "./data")).resolve()
        data_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(data_dir, 0o700)
        key = overrides.pop("secret_key", None) or os.environ.get("HUB_SECRET_KEY", "").encode()
        if not key:
            path = data_dir / "hub-secret.key"
            if not path.exists():
                fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                with os.fdopen(fd, "wb") as stream:
                    stream.write(secrets.token_hex(32).encode())
            key = path.read_bytes().strip()
        if len(key) < 32:
            raise RuntimeError("HUB_SECRET_KEY must be at least 32 characters")
        frontend = os.environ.get("HUB_FRONTEND_DIR")
        values = dict(
            database_url=database_url,
            data_dir=data_dir,
            secret_key=key,
            session_ttl=_int("HUB_SESSION_TTL", 12 * 60 * 60, 300, 30 * 86400),
            secure_cookies=_bool("HUB_SECURE_COOKIES", True),
            max_request_bytes=_int("HUB_MAX_REQUEST_BYTES", 4 * 1024 * 1024, 4096),
            max_backup_upload_bytes=_int("HUB_BACKUP_MAX_UPLOAD_BYTES", 4 * 1024**3, 4096, 2**62),
            rclone_binary=os.environ.get("HUB_RCLONE_BINARY", "rclone"),
            rclone_config=os.environ.get("HUB_RCLONE_CONFIG") or None,
            frontend_dir=Path(frontend).resolve() if frontend else None,
            bootstrap_owner=os.environ.get("HUB_BOOTSTRAP_OWNER") or None,
            bootstrap_password=os.environ.get("HUB_BOOTSTRAP_PASSWORD") or None,
            background_tasks=_bool("HUB_BACKGROUND_TASKS", True),
        )
        values.update(overrides)
        return cls(**values)
