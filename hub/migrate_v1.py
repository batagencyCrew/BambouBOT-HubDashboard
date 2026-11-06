"""Import a v1 hub (SQLite + Fernet key) into v2 Postgres.

* Sites keep their ids, so v1 agent tokens (stored as sha256 hashes in both
  versions) keep working against the v2 compatibility API without re-issuing.
* v1 per-site config (worker count, preset, AI/captcha keys) becomes a managed
  ``config.json``; v1 proxies become a managed ``proxies.txt``. Both are marked
  as already applied (the VPS already has equivalent content).
* Errors/logs, commands, statistics and AI-usage receipts are copied as history.
* Idempotent: every imported row is recorded in ``legacy_imports``.
"""

from __future__ import annotations

import json
import re
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote

from cryptography.fernet import Fernet, InvalidToken

from . import filesync
from .security import SecretBox


def _slug(name: str, taken: set[str]) -> str:
    base = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:60] or "site"
    slug, n = base, 2
    while slug in taken:
        slug = f"{base}-{n}"
        n += 1
    taken.add(slug)
    return slug


def _ts(value):
    if not value:
        return None
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


class _App:
    """Minimal app-like object so filesync helpers can be reused."""
    def __init__(self, settings, db):
        class State:
            pass
        self.state = State()
        self.state.db = db
        self.state.settings = settings
        self.state.secrets = SecretBox(settings.secret_key)

        class Silent:
            def publish(self, event):
                pass

            def send_site(self, site_id, message):
                return False

        self.state.realtime = Silent()


def import_v1(settings, db, sqlite_path: str, key_path: str, data_dir: str | None = None) -> dict:
    source = sqlite3.connect(f"file:{sqlite_path}?mode=ro", uri=True)
    source.row_factory = sqlite3.Row
    fernet = Fernet(Path(key_path).read_bytes().strip())

    def decrypt(value: str) -> str:
        if not value:
            return ""
        try:
            return fernet.decrypt(value.encode()).decode()
        except InvalidToken:
            raise SystemExit("v1 secrets cannot be decrypted with the supplied key") from None

    app = _App(settings, db)
    report = {"sites": 0, "files": 0, "logs": 0, "commands": 0, "metrics": 0, "destinations": 0, "skipped_sites": 0}
    done = {(r["source"], r["legacy_id"]) for r in db.query("SELECT source, legacy_id FROM legacy_imports")}
    taken = {r["slug"] for r in db.query("SELECT slug FROM sites")}

    for dest in source.execute("SELECT * FROM backup_destinations"):
        if ("destination", dest["id"]) in done:
            continue
        db.execute("INSERT INTO backup_destinations(id, name, remote, folder, enabled, created_at) VALUES(%s,%s,%s,%s,%s,%s) "
                   "ON CONFLICT DO NOTHING", (dest["id"], dest["name"], dest["remote"], dest["folder"], bool(dest["enabled"]),
                                              _ts(dest["created_at"])))
        db.execute("INSERT INTO legacy_imports(source, legacy_id, new_id) VALUES('destination', %s, %s)", (dest["id"], dest["id"]))
        report["destinations"] += 1

    for site in source.execute("SELECT * FROM sites ORDER BY created_at"):
        sid = site["id"]
        if ("site", sid) in done:
            report["skipped_sites"] += 1
            continue
        slug = _slug(site["name"], taken)
        with db.transaction() as cur:
            cur.execute("INSERT INTO sites(id, slug, name, url, description, desired_state, created_at) VALUES(%s,%s,%s,%s,%s,%s,%s)",
                        (sid, slug, site["name"], site["url"], site["description"], site["desired_state"], _ts(site["created_at"])))
            cur.execute("INSERT INTO site_tokens(site_id, token_hash, label) VALUES(%s,%s,'imported from v1')",
                        (sid, site["token_hash"]))
            if site["last_seen"]:
                cur.execute("INSERT INTO agent_reports(site_id, last_seen_at, agent_version) VALUES(%s,%s,'v1')",
                            (sid, _ts(site["last_seen"])))
            backup = source.execute("SELECT * FROM backup_configs WHERE site_id=?", (sid,)).fetchone()
            targets = []
            try:
                targets = [r["destination_id"] for r in source.execute("SELECT destination_id FROM backup_targets WHERE site_id=?", (sid,))]
            except sqlite3.OperationalError:
                pass
            cur.execute("INSERT INTO site_backup_config(site_id, enabled, interval_minutes, destination_ids) VALUES(%s,%s,%s,%s::uuid[])",
                        (sid, bool(backup["enabled"]) if backup else False, backup["interval_minutes"] if backup else 1440, targets))
            cur.execute("INSERT INTO legacy_imports(source, legacy_id, new_id) VALUES('site', %s, %s)", (sid, sid))
        report["sites"] += 1

        # --- configuration files -----------------------------------------------
        config = source.execute("SELECT * FROM configs WHERE site_id=?", (sid,)).fetchone()
        if config:
            document = {"number_of_workers": config["number_of_workers"], "ai_preset_id": config["ai_preset_id"],
                        "ai_api_key": decrypt(config["ai_api_key"])}
            captcha = decrypt(config["captcha_api_key"])
            if captcha:
                document["captcha_api_key"] = captcha
            filesync.agent_push(app, sid, "config.json", "json", json.dumps(document, indent=2) + "\n", 0)
            report["files"] += 1
        lines = []
        for proxy in source.execute("SELECT * FROM proxies WHERE site_id=? ORDER BY created_at, id", (sid,)):
            url = proxy["url"]
            if proxy["username"] or proxy["password"]:
                scheme, rest = url.split("://", 1)
                auth = quote(proxy["username"], safe="")
                password = decrypt(proxy["password"])
                if password:
                    auth += ":" + quote(password, safe="")
                url = f"{scheme}://{auth}@{rest}"
            lines.append(url)
        if lines:
            filesync.agent_push(app, sid, "proxies.txt", "proxies", "\n".join(lines) + "\n", 0)
            report["files"] += 1

        # --- history ---------------------------------------------------------------
        level = {"info": 1, "warning": 3, "error": 4}
        rows = [(sid, r["worker_id"], None, _ts(r["timestamp"]), level.get(r["level"], 4),
                 "v1" + (f":{r['code']}" if r["code"] else ""), r["message"]) for r in source.execute(
                    "SELECT * FROM errors WHERE site_id=? ORDER BY timestamp", (sid,))]
        with db.transaction() as cur:
            cur.executemany("INSERT INTO event_logs(site_id, worker_id, worker_name, ts, level, source, message) "
                            "VALUES(%s,%s,%s,%s,%s,%s,%s)", rows)
        report["logs"] += len(rows)
        for command in source.execute("SELECT * FROM commands WHERE site_id=?", (sid,)):
            status = command["status"] if command["status"] in ("pending", "delivered", "completed", "failed") else "failed"
            if status in ("pending", "delivered"):
                status = "failed"  # never replay old lifecycle commands after migration
            db.execute("INSERT INTO commands(id, site_id, action, status, created_at, completed_at, result, source) "
                       "VALUES(%s,%s,%s,%s,%s,%s,%s,'v1') ON CONFLICT DO NOTHING",
                       (command["id"], sid, command["action"], status, _ts(command["created_at"]),
                        _ts(command["completed_at"]), command["message"]))
            report["commands"] += 1
        stats = source.execute("SELECT * FROM statistics WHERE site_id=?", (sid,)).fetchone()
        if stats:
            ts = _ts(stats["updated_at"])
            db.execute("INSERT INTO metrics(site_id, name, labels, ts, kind, value) VALUES(%s,'links_sent_successfully','{}',%s,'gauge',%s)",
                       (sid, ts, stats["links_sent_successfully"]))
            if stats["average_messages_per_chat"] is not None:
                db.execute("INSERT INTO metrics(site_id, name, labels, ts, kind, value) VALUES(%s,'average_messages_per_chat','{}',%s,'gauge',%s)",
                           (sid, ts, stats["average_messages_per_chat"]))
            report["metrics"] += 1
        try:
            usage = source.execute("SELECT payload, timestamp FROM telemetry WHERE site_id=? AND kind='ai' AND payload IS NOT NULL",
                                   (sid,)).fetchall()
        except sqlite3.OperationalError:
            usage = []
        batch = []
        for row in usage:
            payload = json.loads(row["payload"])
            ts = _ts(row["timestamp"])
            labels = json.dumps({"key": payload.get("key_id", "")})
            for name in ("calls", "error_429", "error_502"):
                batch.append((sid, f"ai.{name}", labels, ts, "count", payload.get(name, 0)))
            if payload.get("calls"):
                batch.append((sid, "ai.latency_ms", labels, ts, "gauge", payload.get("latency_ms", 0)))
        if batch:
            with db.transaction() as cur:
                cur.executemany("INSERT INTO metrics(site_id, name, labels, ts, kind, value) VALUES(%s,%s,%s::jsonb,%s,%s,%s)", batch)
            report["metrics"] += len(batch)
    return report
