"""v1 SQLite → v2 import, using a synthetic v1 database built with the real v1 schema."""

import hashlib
import json
import sqlite3

from cryptography.fernet import Fernet

from hub.migrate_v1 import import_v1

SITE = "7ef6395e-6516-48ce-b591-d5ca3d2a5ad2"
TOKEN = "legacy-agent-token"


def _v1(tmp_path):
    key = Fernet.generate_key()
    (tmp_path / "encryption.key").write_bytes(key)
    f = Fernet(key)
    db = sqlite3.connect(tmp_path / "hub.sqlite3")
    db.executescript("""
        CREATE TABLE sites (id TEXT PRIMARY KEY, name TEXT, url TEXT, description TEXT, desired_state TEXT,
            reported_status TEXT, last_seen TEXT, created_at TEXT, token_hash TEXT);
        CREATE TABLE configs (site_id TEXT, number_of_workers INTEGER, ai_preset_id TEXT, ai_api_key TEXT,
            captcha_api_key TEXT, updated_at TEXT, revision INTEGER, admin_modified INTEGER, local_sync_initialized INTEGER);
        CREATE TABLE proxies (id TEXT, site_id TEXT, url TEXT, username TEXT, password TEXT, created_at TEXT);
        CREATE TABLE errors (id TEXT, site_id TEXT, worker_id TEXT, level TEXT, message TEXT, timestamp TEXT, proxy_id TEXT, code TEXT);
        CREATE TABLE commands (id TEXT, site_id TEXT, action TEXT, status TEXT, created_at TEXT, completed_at TEXT, message TEXT);
        CREATE TABLE statistics (site_id TEXT, links_sent_successfully INTEGER, average_messages_per_chat REAL, updated_at TEXT);
        CREATE TABLE backup_destinations (id TEXT, name TEXT, remote TEXT, folder TEXT, enabled INTEGER, created_at TEXT);
        CREATE TABLE backup_configs (site_id TEXT, enabled INTEGER, interval_minutes INTEGER, agent_configured INTEGER,
            agent_last_seen TEXT, next_backup_at TEXT);
        CREATE TABLE telemetry (seq INTEGER, site_id TEXT, event_id TEXT, kind TEXT, digest TEXT, timestamp TEXT, payload TEXT);
    """)
    db.execute("INSERT INTO sites VALUES(?,?,?,?,?,?,?,?,?)", (SITE, "alpha", "https://alpha.example", "", "running", "healthy",
                                                             "2026-11-06T11:46:06Z", "2026-10-17T00:00:00Z",
                                                             hashlib.sha256(TOKEN.encode()).hexdigest()))
    db.execute("INSERT INTO configs VALUES(?,?,?,?,?,?,?,?,?)", (SITE, 5, "5818", f.encrypt(b"bbk_live").decode(), "",
                                                               "2026-11-01T00:00:00Z", 3, 1, 1))
    db.execute("INSERT INTO proxies VALUES(?,?,?,?,?,?)", ("p1", SITE, "http://1.2.3.4:8080", "user", f.encrypt(b"p@ss").decode(),
                                                         "2026-11-01T00:00:00Z"))
    db.execute("INSERT INTO errors VALUES(?,?,?,?,?,?,?,?)", ("e1", SITE, None, "error", "boom", "2026-11-05T00:00:00Z", None, None))
    db.execute("INSERT INTO commands VALUES(?,?,?,?,?,?,?)", ("6e1b7c1a-0000-4000-8000-000000000001", SITE, "start", "delivered",
                                                            "2026-11-05T00:00:00Z", None, None))
    db.execute("INSERT INTO statistics VALUES(?,?,?,?)", (SITE, 10, 2.5, "2026-11-05T00:00:00Z"))
    db.execute("INSERT INTO telemetry VALUES(1,?,?,?,?,?,?)", (SITE, "ev", "ai", "d", "2026-11-05T00:00:00Z",
                                                              json.dumps({"key_id": "main", "calls": 3, "error_429": 1,
                                                                          "error_502": 0, "latency_ms": 500})))
    db.commit()
    return tmp_path / "hub.sqlite3", tmp_path / "encryption.key"


def test_import_preserves_tokens_and_secrets(client, tmp_path):
    sqlite_path, key_path = _v1(tmp_path)
    app = client.app
    report = import_v1(app.state.settings, app.state.db, str(sqlite_path), str(key_path))
    assert report["sites"] == 1 and report["files"] == 2 and report["logs"] == 1
    assert import_v1(app.state.settings, app.state.db, str(sqlite_path), str(key_path))["skipped_sites"] == 1
    # The legacy token authenticates against the v1-compatible agent API.
    config = client.get("/api/agent/config", headers={"Authorization": f"Bearer {TOKEN}"}).json()
    assert config["ai_api_key"] == "bbk_live" and config["number_of_workers"] == 5
    assert config["proxies"][0]["password"] == "p@ss"
    # Pending v1 commands are never replayed after migration.
    assert client.get("/api/agent/commands", headers={"Authorization": f"Bearer {TOKEN}"}).json() == []
