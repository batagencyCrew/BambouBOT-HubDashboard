"""Operator commands.

    python -m hub.cli migrate
    python -m hub.cli create-user <username> --role owner        (prompts for password)
    python -m hub.cli import-v1 --sqlite /path/hub.sqlite3 --key /path/encryption.key
    python -m hub.cli bot-token
"""

from __future__ import annotations

import argparse
import getpass
import sys

from .config import Settings
from .db import Database
from .permissions import ROLES
from .security import hash_password


def _db() -> tuple[Settings, Database]:
    settings = Settings.from_env()
    db = Database(settings.database_url, max_size=4)
    db.open()
    return settings, db


def cmd_migrate(args):
    _, db = _db()
    applied = db.migrate()
    db.ensure_partitions()
    print(f"Applied migrations: {applied or 'none (up to date)'}")


def cmd_create_user(args):
    _, db = _db()
    db.migrate()
    password = args.password or getpass.getpass("Password (min 12 chars): ")
    if len(password) < 12:
        sys.exit("Password must be at least 12 characters")
    if db.one("SELECT 1 AS x FROM users WHERE username=%s", (args.username.lower(),)):
        db.execute("UPDATE users SET password_hash=%s, role=%s, disabled=false, password_changed_at=now() WHERE username=%s",
                   (hash_password(password), args.role, args.username.lower()))
        print(f"Updated {args.username}")
    else:
        db.execute("INSERT INTO users(username, display_name, password_hash, role) VALUES(%s,%s,%s,%s)",
                   (args.username.lower(), args.display_name or args.username, hash_password(password), args.role))
        print(f"Created {args.role} {args.username}")


def cmd_bot_token(args):
    import secrets
    from .auth import sha256
    _, db = _db()
    db.migrate()
    token = "hbt_" + secrets.token_urlsafe(40)
    db.execute("INSERT INTO service_tokens(kind, label, token_hash) VALUES('bot', %s, %s)", (args.label, sha256(token)))
    print(token)


def cmd_import_v1(args):
    from .migrate_v1 import import_v1
    settings, db = _db()
    db.migrate()
    db.ensure_partitions()
    report = import_v1(settings, db, args.sqlite, args.key, args.data_dir)
    for key, value in report.items():
        print(f"{key}: {value}")


def main(argv=None):
    parser = argparse.ArgumentParser(prog="hub")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("migrate").set_defaults(func=cmd_migrate)
    user = sub.add_parser("create-user")
    user.add_argument("username")
    user.add_argument("--role", choices=ROLES, default="owner")
    user.add_argument("--display-name", default="")
    user.add_argument("--password", help="Avoid on shared hosts; prompts if omitted")
    user.set_defaults(func=cmd_create_user)
    bot = sub.add_parser("bot-token")
    bot.add_argument("--label", default="BambouBot")
    bot.set_defaults(func=cmd_bot_token)
    v1 = sub.add_parser("import-v1")
    v1.add_argument("--sqlite", required=True)
    v1.add_argument("--key", required=True, help="v1 encryption.key (Fernet) file")
    v1.add_argument("--data-dir", help="v1 data dir (for backup config); defaults to the sqlite file's folder")
    v1.set_defaults(func=cmd_import_v1)
    args = parser.parse_args(argv)
    args.func(args)


if __name__ == "__main__":
    main()
