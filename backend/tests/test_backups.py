"""All persistence is temporary; no production config, network or cloud access."""

import asyncio
from contextlib import contextmanager
import hashlib
import os
import stat
import sqlite3
import subprocess
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from uuid import uuid4

import pytest
import anyio
import httpx
from fastapi.testclient import TestClient

from hub.app import BodyLimit, MAX_BODY, create_app
from hub.backups import DestinationCreate, DestinationPatch


@pytest.fixture
def configured(app, client, admin, site, monkeypatch):
    monkeypatch.setattr(app.state.backups, "remotes", lambda: {"available": True, "remotes": ["cloud", "other"], "message": None})
    destination = client.post("/api/backup-destinations", headers=admin,
                              json={"name": "Drive", "remote": "cloud", "folder": "daily snapshots"})
    assert destination.status_code == 201, destination.text
    destination = destination.json()
    site_id, agent = site
    result = client.put(f"/api/sites/{site_id}/backup-config", headers=admin,
                        json={"enabled": False, "destination_ids": [destination["id"]]})
    assert result.status_code == 200
    return site_id, agent, destination


def upload(client, agent, data=b"opaque\0data", **params):
    return client.post("/api/agent/backups/upload", params={"filename": "anything.bin", **params},
                       headers={**agent, "Content-Type": "application/octet-stream"}, content=data)


def history(client, admin, site_id):
    response = client.get(f"/api/sites/{site_id}/backups", headers=admin)
    assert response.status_code == 200
    return response.json()


def fake_process(monkeypatch, codes, calls=None):
    class Process:
        def __init__(self, argv, **kwargs):
            self.code = codes.pop(0)
            if calls is not None:
                calls.append((argv, kwargs))

        def wait(self, timeout=None):
            return self.code

    monkeypatch.setattr("hub.backups.subprocess.Popen", Process)


def test_defaults_auth_and_telemetry(client, admin, site):
    site_id, agent = site
    path = f"/api/sites/{site_id}/backup-config"
    default = client.get(path, headers=admin).json()
    assert default == {"enabled": False, "interval_minutes": 1440, "destination_ids": [],
                       "agent_configured": False, "agent_last_seen": None, "next_backup_at": None}
    for endpoint in ("/api/backup-storage", "/api/backup-remotes", "/api/backup-destinations", path):
        assert client.get(endpoint).status_code == 401
        assert client.get(endpoint, headers=agent).status_code == 401
    for endpoint in ("backup-config", "backup-requests"):
        assert client.get("/api/agent/" + endpoint, headers=admin).status_code == 401
    assert client.post("/api/agent/backup-status", headers=agent, json={"configured": True, "next_backup_at": "2030-01-01T00:00:00Z"}).status_code == 200
    updated = client.get(path, headers=admin).json()
    assert updated["agent_configured"] and updated["agent_last_seen"]
    assert updated == client.get("/api/agent/backup-config", headers=agent).json()
    assert history(client, admin, site_id) == {"backups": [], "requests": []}
    assert client.post("/api/agent/backup-status", headers=agent, json={"configured": True, "source_path": "/x"}).status_code == 422
    assert upload(client, agent).status_code == 409
    assert upload(client, admin).status_code == 401


@pytest.mark.parametrize("remote", ["/tmp/x", "../x", "x:", "-x", ":local:", "https://x", "x\n", "x y", "x\\y"])
def test_remote_validation(remote):
    with pytest.raises(ValueError):
        DestinationCreate(name="x", remote=remote)
    with pytest.raises(ValueError):
        DestinationPatch(remote=remote)


@pytest.mark.parametrize("folder", ["/absolute", "../parent", "a/../x", "a//b", "./x", "x/", "x\\y", "x:y", "--flag", "x/--flag", "x\n"])
def test_folder_validation(folder):
    with pytest.raises(ValueError):
        DestinationCreate(name="x", remote="cloud", folder=folder)


@pytest.mark.parametrize("filename", ["../bad", "a/b", "a\\b", ".", "..", "--flag", "x\n", "x" * 201, ""])
def test_filename_validation(client, configured, filename):
    _, agent, _ = configured
    assert upload(client, agent, filename=filename).status_code == 422


def test_destination_and_config_validation(client, admin, configured):
    site_id, _, destination = configured
    path = f"/api/sites/{site_id}/backup-config"
    assert client.post("/api/backup-destinations", headers=admin, json={"name": "x", "remote": "unknown"}).status_code == 422
    for body in ({"enabled": True, "destination_ids": []},
                 {"enabled": False, "destination_ids": [str(uuid4())]},
                 {"enabled": False, "destination_ids": [destination["id"]] * 2},
                 {"enabled": True, "destination_ids": [destination["id"]], "interval_minutes": 14},
                 {"enabled": True, "destination_ids": [destination["id"]], "interval_minutes": 43201},
                 {"enabled": True, "destination_ids": [destination["id"]], "interval_minutes": True}):
        assert client.put(path, headers=admin, json=body).status_code in (409, 422)
    dpath = "/api/backup-destinations/" + destination["id"]
    assert client.patch(dpath, headers=admin, json={"folder": None}).status_code == 422
    assert client.patch(dpath, headers=admin, json={"name": "x" * 201}).status_code == 422
    assert client.delete(dpath, headers=admin).status_code == 409
    assert client.patch(dpath, headers=admin, json={"enabled": False}).status_code == 200
    assert client.put(path, headers=admin, json={"enabled": True, "destination_ids": [destination["id"]]}).status_code == 409
    assert client.put(path, headers=admin, json={"enabled": False, "destination_ids": []}).status_code == 200
    assert client.delete(dpath, headers=admin).status_code == 204
    assert client.delete(dpath, headers=admin).status_code == 404


@pytest.mark.parametrize("data,filename", [(b"", "empty"), (bytes(range(256)), "binary.file"), (b"x" * (MAX_BODY + 1), "big.unknown")])
def test_upload_hash_download_permissions(client, admin, configured, app, data, filename):
    site_id, agent, _ = configured
    response = upload(client, agent, data, filename=filename)
    assert response.status_code == 201, response.text
    backup = response.json()
    assert backup["sha256"] == hashlib.sha256(data).hexdigest()
    assert backup["size_bytes"] == len(data) and backup["local_available"]
    assert backup["status"] == "queued" and len(backup["transfers"]) == 1
    transfer = backup["transfers"][0]
    assert transfer["attempts"] == 0 and transfer["status"] == "queued"
    assert transfer["remote_path"] == f'daily snapshots/{site_id}/{backup["id"]}/{filename}'
    assert str(app.state.backups.root) not in response.text
    assert stat.S_IMODE(app.state.backups.path(backup["id"]).stat().st_mode) == 0o600
    assert stat.S_IMODE(app.state.backups.root.stat().st_mode) == 0o700
    result = client.get(f'/api/sites/{site_id}/backups/{backup["id"]}/download', headers=admin)
    assert result.content == data and result.headers["content-type"] == "application/octet-stream"
    assert result.headers["content-disposition"].startswith("attachment;")
    assert result.headers["x-content-type-options"] == "nosniff"
    assert app.state.backups.downloads == {}
    assert client.delete(f'/api/sites/{site_id}/backups/{backup["id"]}/local', headers=admin).status_code == 409
    assert client.delete(f"/api/sites/{site_id}", headers=admin).status_code == 409
    assert client.get("/api/backup-storage", headers=admin).json()["used_bytes"] == len(data)


def test_request_snapshots_at_least_once_and_ack(client, admin, configured, app):
    site_id, agent, destination = configured
    prefix = f"/api/sites/{site_id}"
    req = client.post(prefix + "/backups/request", headers=admin, json={}).json()
    assert req["status"] == "pending" and req["backup_id"] is None
    first = client.get("/api/agent/backup-requests", headers=agent).json()
    assert first[0]["status"] == "delivered"
    assert first == client.get("/api/agent/backup-requests", headers=agent).json()
    assert client.patch("/api/backup-destinations/" + destination["id"], headers=admin,
                        json={"remote": "other", "folder": "new", "name": "new"}).status_code == 200
    assert client.put(prefix + "/backup-config", headers=admin, json={"enabled": False, "destination_ids": []}).status_code == 200
    result = upload(client, agent, source="on_demand", request_id=req["id"])
    assert result.status_code == 201, result.text
    backup = result.json()
    assert backup["transfers"][0]["destination_name"] == "Drive"
    with app.state.store.transaction() as db:
        assert db.execute("SELECT remote FROM backup_transfers").fetchone()[0] == "cloud"
    assert history(client, admin, site_id)["requests"][0]["status"] == "uploaded"
    assert upload(client, agent, request_id=req["id"]).status_code == 409
    assert client.post(f'/api/agent/backup-requests/{req["id"]}/ack', headers=agent, json={"status": "failed"}).status_code == 409
    assert upload(client, agent, source="on_demand").status_code == 422


def test_requests_scope_limit_and_sanitized_ack(client, admin, configured):
    site_id, agent, _ = configured
    other = client.post("/api/sites", headers=admin, json={"name": "other", "url": "https://example.org"}).json()
    other_agent = {"Authorization": "Bearer " + other["agent_token"]}
    for _ in range(20):
        result = client.post(f"/api/sites/{site_id}/backups/request", headers=admin, json={})
        assert result.status_code == 201
    req = result.json()
    assert client.post(f"/api/sites/{site_id}/backups/request", headers=admin, json={}).status_code == 409
    assert upload(client, other_agent, request_id=req["id"]).status_code == 404
    assert client.post(f'/api/agent/backup-requests/{req["id"]}/ack', headers=other_agent, json={"status": "failed"}).status_code == 404
    result = client.post(f'/api/agent/backup-requests/{req["id"]}/ack', headers=agent,
                         json={"status": "failed", "message": "bad\n\0" + "x" * 1000})
    assert result.status_code == 200
    assert len(result.json()["message"]) == 500 and "\n" not in result.json()["message"]
    assert client.delete(f"/api/sites/{site_id}", headers=admin).status_code == 204


def test_quota_cleanup_and_empty_file(client, admin, configured, app):
    site_id, agent, _ = configured
    service = app.state.backups
    service.max_upload, service.max_storage = 6, 8
    assert upload(client, agent, b"1234567").status_code == 413
    # Generators exercise chunked bodies with no Content-Length.
    assert upload(client, agent, iter([b"1234", b"567"])).status_code == 413
    assert list(service.root.glob("*.part")) == []
    assert client.get("/api/backup-storage", headers=admin).json()["used_bytes"] == 0
    assert upload(client, agent, b"123456").status_code == 201
    assert upload(client, agent, b"123").status_code == 507
    assert upload(client, agent, iter([b"1", b"23"])).status_code == 507
    assert upload(client, agent, b"").status_code == 201
    assert client.get("/api/backup-storage", headers=admin).json()["used_bytes"] == 6
    assert list(service.root.glob("*.part")) == []
    assert all(not b["local_available"] for b in history(client, admin, site_id)["backups"] if b["status"] == "failed")


def test_content_type_and_length(client, configured):
    _, agent, _ = configured
    assert client.post("/api/agent/backups/upload?filename=x", headers=agent, content=b"x").status_code == 415
    for length, status_code in [("no", 400), ("-1", 400), ("2", 400)]:
        result = client.post("/api/agent/backups/upload?filename=x", headers={**agent, "Content-Type": "application/octet-stream", "Content-Length": length}, content=b"x")
        assert result.status_code == status_code


def test_transfer_success_fixed_argv_snapshot_and_eviction(client, admin, configured, app, monkeypatch):
    site_id, agent, destination = configured
    backup = upload(client, agent).json()
    client.patch("/api/backup-destinations/" + destination["id"], headers=admin, json={"remote": "other", "folder": "later"})
    calls = []
    fake_process(monkeypatch, [0], calls)
    assert app.state.backups.transfer_one()
    completed = history(client, admin, site_id)["backups"][0]
    assert completed["status"] == "completed" and completed["completed_at"]
    assert completed["transfers"][0]["attempts"] == 1
    args, kwargs = calls[0]
    assert args[1] == "copyto" and args[3].startswith("cloud:daily snapshots/")
    assert kwargs.get("shell", False) is False and kwargs["stderr"] == subprocess.DEVNULL
    prefix = f'/api/sites/{site_id}/backups/{backup["id"]}'
    assert client.post(prefix + "/retry", headers=admin, json={}).status_code == 409
    assert client.delete(prefix + "/local", headers=admin).status_code == 204
    assert not history(client, admin, site_id)["backups"][0]["local_available"]
    assert client.get(prefix + "/download", headers=admin).status_code == 404
    assert client.get("/api/backup-storage", headers=admin).json()["used_bytes"] == 0


def test_multi_destination_partial_retry_disabled_and_history(client, admin, configured, app, monkeypatch):
    site_id, agent, first = configured
    second = client.post("/api/backup-destinations", headers=admin, json={"name": "second", "remote": "other"}).json()
    client.put(f"/api/sites/{site_id}/backup-config", headers=admin, json={"enabled": True, "destination_ids": [first["id"], second["id"]]})
    backup = upload(client, agent).json()
    service = app.state.backups
    fake_process(monkeypatch, [0, 1, 1, 1])
    assert service.transfer_one()
    for _ in range(3):
        with app.state.store.transaction() as db:
            db.execute("UPDATE backup_transfers SET next_attempt=0")
        assert service.transfer_one()
    result = history(client, admin, site_id)["backups"][0]
    assert result["status"] == "partial"
    failed = next(t for t in result["transfers"] if t["status"] == "failed")
    complete = next(t for t in result["transfers"] if t["status"] == "completed")
    assert failed["attempts"] == 3 and complete["attempts"] == 1
    prefix = f'/api/sites/{site_id}/backups/{backup["id"]}'
    client.patch("/api/backup-destinations/" + failed["destination_id"], headers=admin, json={"enabled": False})
    assert client.post(prefix + "/retry", headers=admin, json={}).status_code == 409
    client.patch("/api/backup-destinations/" + failed["destination_id"], headers=admin, json={"enabled": True})
    assert client.post(prefix + "/retry", headers=admin, json={}).json()["status"] == "queued"
    fake_process(monkeypatch, [0])
    assert service.transfer_one()
    result = history(client, admin, site_id)["backups"][0]
    assert result["status"] == "completed"
    assert next(t for t in result["transfers"] if t["id"] == complete["id"]) == complete
    client.put(f"/api/sites/{site_id}/backup-config", headers=admin, json={"enabled": False, "destination_ids": []})
    assert client.delete("/api/backup-destinations/" + first["id"], headers=admin).status_code == 204
    assert len(history(client, admin, site_id)["backups"][0]["transfers"]) == 2


def test_disabled_dispatch_and_missing_cache(client, admin, configured, app, monkeypatch):
    site_id, agent, destination = configured
    backup = upload(client, agent).json()
    client.patch("/api/backup-destinations/" + destination["id"], headers=admin, json={"enabled": False})
    monkeypatch.setattr("hub.backups.subprocess.Popen", lambda *a, **k: pytest.fail("Disabled target dispatched"))
    assert app.state.backups.transfer_one()
    result = history(client, admin, site_id)["backups"][0]
    assert result["status"] == "failed" and result["transfers"][0]["attempts"] == 0
    client.patch("/api/backup-destinations/" + destination["id"], headers=admin, json={"enabled": True})
    app.state.backups.path(backup["id"]).unlink()
    assert client.post(f'/api/sites/{site_id}/backups/{backup["id"]}/retry', headers=admin, json={}).status_code == 409


def test_recovery_retention_and_idempotent_migration(client, admin, configured, app, tmp_path, monkeypatch):
    site_id, agent, _ = configured
    service = app.state.backups
    backups = [upload(client, agent).json() for _ in range(4)]
    old = (datetime.now(timezone.utc) - timedelta(days=10)).isoformat()
    with app.state.store.transaction() as db:
        db.execute("UPDATE backup_transfers SET status='transferring' WHERE backup_id=?", (backups[0]["id"],))
        db.execute("UPDATE backups SET status='uploading' WHERE id=?", (backups[1]["id"],))
        db.execute("UPDATE backups SET status='completed',completed_at=? WHERE id=?", (old, backups[2]["id"]))
        db.execute("UPDATE backup_transfers SET status='completed' WHERE backup_id=?", (backups[2]["id"],))
    service.path(backups[3]["id"]).unlink()
    # Creating another app adds schema only, never performs live recovery.
    second_app = create_app(data_dir=service.root.parent, admin_password="test-password")
    with second_app.state.store.transaction() as db:
        assert db.execute("SELECT status FROM backups WHERE id=?", (backups[1]["id"],)).fetchone()[0] == "uploading"
    service.recover()
    rows = {b["id"]: b for b in history(client, admin, site_id)["backups"]}
    assert rows[backups[0]["id"]]["transfers"][0]["status"] == "queued"
    assert rows[backups[1]["id"]]["status"] == "failed"
    assert not service.path(backups[1]["id"]).exists()
    assert rows[backups[3]["id"]]["status"] == "failed"
    service.retain()
    assert not service.path(backups[2]["id"]).exists()
    assert service.path(backups[0]["id"]).exists()


@pytest.mark.parametrize("variable,value", [
    ("HUB_BACKUP_MAX_UPLOAD_BYTES", "0"), ("HUB_BACKUP_MAX_STORAGE_BYTES", "-1"),
    ("HUB_BACKUP_RETENTION_DAYS", "1.5"), ("HUB_BACKUP_TRANSFER_TIMEOUT_SECONDS", "9999999"),
    ("HUB_BACKUP_WORKER_ENABLED", "maybe"), ("HUB_BACKUP_MAX_UPLOAD_BYTES", "9" * 100),
])
def test_environment_strict(tmp_path, monkeypatch, variable, value):
    monkeypatch.setenv(variable, value)
    with pytest.raises(RuntimeError, match=variable):
        create_app(data_dir=tmp_path, admin_password="test")


def test_exact_body_limit_bypass():
    async def run(path):
        routed, sent = [], []

        async def downstream(scope, receive, send):
            routed.append(await receive())

        async def receive():
            return {"type": "http.request", "body": b"x" * (MAX_BODY + 1), "more_body": False}

        async def send(message):
            sent.append(message)

        await BodyLimit(downstream)({"type": "http", "path": path}, receive, send)
        return routed, sent

    assert asyncio.run(run("/api/agent/backups/upload"))[0]
    for path in ("/api/agent/backups/upload/", "/api/agent/backups/upload/evil", "/api/agent/backup-status"):
        routed, sent = asyncio.run(run(path))
        assert not routed and sent[0]["status"] == 413


def test_real_local_rclone(tmp_path, monkeypatch):
    binary = Path("/usr/local/bin/rclone")
    if not binary.exists():
        pytest.skip("rclone not installed")
    config = tmp_path / "rclone.conf"
    config.write_text("[disk]\ntype = local\n")
    monkeypatch.setenv("HUB_RCLONE_BINARY", str(binary))
    monkeypatch.setenv("HUB_RCLONE_CONFIG", str(config))
    # Relative local remote folder resolves under this isolated working directory.
    monkeypatch.chdir(tmp_path)
    app = create_app(data_dir=tmp_path / "hub", admin_password="test")
    with TestClient(app) as client:
        admin = {"Authorization": "Bearer " + client.post("/api/auth/login", json={"password": "test"}).json()["access_token"]}
        remote_result = client.get("/api/backup-remotes", headers=admin).json()
        assert remote_result["available"] and "disk" in remote_result["remotes"]
        site = client.post("/api/sites", headers=admin, json={"name": "local", "url": "https://example.com"}).json()
        site_id, agent = site["site"]["id"], {"Authorization": "Bearer " + site["agent_token"]}
        dest = client.post("/api/backup-destinations", headers=admin, json={"name": "local", "remote": "disk", "folder": "copies"}).json()
        assert client.put(f"/api/sites/{site_id}/backup-config", headers=admin, json={"enabled": False, "destination_ids": [dest["id"]]}).status_code == 200
        backup = upload(client, agent, b"real local binary\0").json()
        assert app.state.backups.transfer_one()
        assert history(client, admin, site_id)["backups"][0]["status"] == "completed"
        assert (tmp_path / "copies" / site_id / backup["id"] / backup["filename"]).read_bytes() == b"real local binary\0"


def test_delete_terminal_site_cleans_private_cache_not_cloud(client, admin, configured, app, monkeypatch):
    site_id, agent, _ = configured
    backup = upload(client, agent).json()
    fake_process(monkeypatch, [0])
    app.state.backups.transfer_one()
    assert app.state.backups.path(backup["id"]).exists()
    assert client.delete(f"/api/sites/{site_id}", headers=admin).status_code == 204
    assert not app.state.backups.path(backup["id"]).exists()
    with app.state.store.transaction() as db:
        for table in ("backups", "backup_requests", "backup_targets", "backup_configs", "backup_transfers"):
            assert db.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0] == 0
    assert client.get("/api/agent/backup-config", headers=agent).status_code == 401


def test_download_lease_prevents_eviction_and_retention(client, admin, configured, app, monkeypatch):
    site_id, agent, _ = configured
    backup = upload(client, agent).json()
    fake_process(monkeypatch, [0])
    service = app.state.backups
    service.transfer_one()
    key = backup["id"]
    with app.state.store.transaction() as db:
        db.execute("UPDATE backups SET completed_at='2000-01-01T00:00:00Z'")
    service.downloads[key] = 1
    assert client.delete(f"/api/sites/{site_id}/backups/{key}/local", headers=admin).status_code == 409
    assert client.delete(f"/api/sites/{site_id}", headers=admin).status_code == 409
    service.retain()
    assert service.path(key).exists()
    service.downloads.clear()
    service.retain()
    assert not service.path(key).exists()


def test_worker_start_stop_lock_and_recovery(tmp_path, monkeypatch):
    monkeypatch.setenv("HUB_BACKUP_WORKER_ENABLED", "true")
    app = create_app(data_dir=tmp_path, admin_password="test")
    service = app.state.backups
    recovered = []
    original = service.recover

    def recover():
        recovered.append(True)
        original()

    monkeypatch.setattr(service, "recover", recover)
    other = create_app(data_dir=tmp_path, admin_password="test").state.backups
    with TestClient(app):
        assert service.thread.is_alive() and len(recovered) == 1
        service.start()
        assert len(recovered) == 1
        with pytest.raises(RuntimeError, match="already running"):
            other.start()
    assert service.thread is None and service.worker_lock is None
    other.start()
    other.stop()


def test_worker_shutdown_terminates_and_requeues(client, admin, configured, app, monkeypatch):
    site_id, agent, _ = configured
    upload(client, agent)
    entered = threading.Event()
    terminated = threading.Event()

    class Process:
        def __init__(self, *args, **kwargs):
            entered.set()

        def poll(self):
            return -15 if terminated.is_set() else None

        def wait(self, timeout=None):
            if terminated.wait(min(timeout or 0.05, 0.05)):
                return -15
            raise subprocess.TimeoutExpired("rclone", timeout)

        def terminate(self):
            terminated.set()

    monkeypatch.setattr("hub.backups.subprocess.Popen", Process)
    service = app.state.backups
    service.enabled = True
    service.start()
    assert entered.wait(3)
    assert history(client, admin, site_id)["backups"][0]["status"] == "transferring"
    assert client.delete(f"/api/sites/{site_id}", headers=admin).status_code == 409
    service.stop()
    assert terminated.is_set() and service.thread is None
    assert history(client, admin, site_id)["backups"][0]["status"] == "queued"


def test_timeout_and_launch_failure_are_sanitized(client, admin, configured, app, monkeypatch):
    site_id, agent, _ = configured
    upload(client, agent)
    service = app.state.backups
    service.timeout = 0.001
    terminated = []

    class TimeoutProcess:
        done = False

        def __init__(self, *args, **kwargs):
            pass

        def wait(self, timeout=None):
            if self.done:
                return -15
            raise subprocess.TimeoutExpired("secret rclone path", timeout)

        def terminate(self):
            self.done = True
            terminated.append(True)

    monkeypatch.setattr("hub.backups.subprocess.Popen", TimeoutProcess)
    assert service.transfer_one()
    assert terminated
    result = history(client, admin, site_id)["backups"][0]
    assert result["transfers"][0]["status"] == "queued"
    assert result["transfers"][0]["error"] == "Cloud transfer timed out"
    with app.state.store.transaction() as db:
        db.execute("UPDATE backup_transfers SET next_attempt=0,attempts=2")

    def broken(*args, **kwargs):
        raise OSError("secret path or credential")

    monkeypatch.setattr("hub.backups.subprocess.Popen", broken)
    service.transfer_one()
    result = history(client, admin, site_id)["backups"][0]
    assert result["status"] == "failed"
    assert "secret" not in str(result)


def test_raw_asgi_disconnect_cancellation_and_concurrent_reservations(app, client, admin, configured):
    from starlette.requests import ClientDisconnect

    site_id, agent, _ = configured
    service = app.state.backups
    service.max_storage = 10
    endpoint = next(r.endpoint for r in app.routes if getattr(r, "path", None) == "/api/agent/backups/upload")

    class Body:
        headers = {"content-type": "application/octet-stream"}

        def __init__(self, error):
            self.error = error

        async def stream(self):
            yield b"123456"
            if self.error:
                raise self.error

    for error in (ClientDisconnect(), asyncio.CancelledError()):
        with pytest.raises(type(error)):
            asyncio.run(endpoint(Body(error), site_id, "x", None, "direct"))
        with app.state.store.transaction() as db:
            assert service.used(db) == 0
        assert not list(service.root.glob("*.part"))

    async def concurrent():
        first_reserved = asyncio.Event()
        finish = asyncio.Event()

        class Paused:
            headers = Body.headers

            async def stream(self):
                yield b"123456"
                first_reserved.set()
                await finish.wait()

        first = asyncio.create_task(endpoint(Paused(), site_id, "one", None, "direct"))
        await first_reserved.wait()
        try:
            from fastapi import HTTPException
            with pytest.raises(HTTPException) as caught:
                await endpoint(Body(None), site_id, "two", None, "direct")
            assert caught.value.status_code == 507
        finally:
            finish.set()
            result = await first
        return result

    assert asyncio.run(concurrent())["size_bytes"] == 6
    with app.state.store.transaction() as db:
        assert service.used(db) == 6


def test_upload_time_limits_and_cleanup(app, client, admin, configured, monkeypatch):
    from fastapi import HTTPException
    from hub.backups import upload_chunks

    site_id, _, _ = configured
    endpoint = next(r.endpoint for r in app.routes if getattr(r, "path", None) == "/api/agent/backups/upload")

    class Slow:
        headers = {"content-type": "application/octet-stream"}

        async def stream(self):
            yield b"123"
            await asyncio.sleep(1)
            yield b"456"

    def short_chunks(request):
        return upload_chunks(request, idle_timeout=0.01, total_timeout=0.05)

    monkeypatch.setattr("hub.backups.upload_chunks", short_chunks)
    with pytest.raises(HTTPException) as caught:
        asyncio.run(endpoint(Slow(), site_id, "slow", None, "direct"))
    assert caught.value.status_code == 408
    assert not list(app.state.backups.root.glob("*.part"))
    with app.state.store.transaction() as db:
        assert app.state.backups.used(db) == 0

    async def total_limit():
        class Drip:
            async def stream(self):
                while True:
                    await asyncio.sleep(0.005)
                    yield b"x"

        with pytest.raises(HTTPException) as caught:
            async for _ in upload_chunks(Drip(), idle_timeout=0.1, total_timeout=0.02):
                pass
        assert caught.value.status_code == 408

    asyncio.run(total_limit())


def test_remotes_bounded_failure_and_no_secret_output(app, monkeypatch):
    service = app.state.backups

    def output(argv, stdout, **kwargs):
        assert argv == [service.binary, "listremotes", "--config", service.config]
        stdout.write(b"cloud:\n:bad:\n../unsafe:\nother:\n")
        return subprocess.CompletedProcess(argv, 0)

    monkeypatch.setattr("hub.backups.subprocess.run", output)
    assert service.remotes() == {"available": True, "remotes": ["cloud", "other"], "message": None}

    def unavailable(*args, **kwargs):
        raise subprocess.TimeoutExpired("secret credentials", 10)

    monkeypatch.setattr("hub.backups.subprocess.run", unavailable)
    response = service.remotes()
    assert response["available"] is False and "secret" not in str(response)


def seed_backups(app, site_id, count, status):
    with app.state.store.transaction() as db:
        db.executemany(
            "INSERT INTO backups(id,site_id,filename,status,source,created_at) VALUES(?,?,?,?,'direct',?)",
            [(str(uuid4()), site_id, "empty", status, "2030-01-01T00:00:00Z") for _ in range(count)],
        )


@pytest.mark.parametrize("scope,status,count,expected", [
    ("site", "uploading", 5, 429),
    ("global", "uploading", 20, 429),
    ("site", "queued", 100, 409),
    ("global", "queued", 1000, 409),
])
def test_zero_byte_queue_and_reservation_limits(client, admin, configured, app, scope, status, count, expected):
    site_id, agent, _ = configured
    owner = site_id
    if scope == "global":
        owner = client.post("/api/sites", headers=admin, json={"name": "other", "url": "https://example.org"}).json()["site"]["id"]
    seed_backups(app, owner, count, status)
    result = upload(client, agent, b"")
    assert result.status_code == expected, result.text
    if expected == 429:
        assert result.headers["retry-after"] == "60"
    with app.state.store.transaction() as db:
        assert db.execute("SELECT COUNT(*) FROM backups").fetchone()[0] == count
        db.execute("UPDATE backups SET status='failed'")
    assert not list(app.state.backups.root.glob("*.part"))
    # Terminal metadata does not reserve an active slot; zero-byte uploads remain valid.
    assert upload(client, agent, b"").status_code == 201


def test_retry_cannot_bypass_active_queue_limit(client, admin, configured, app):
    site_id, agent, _ = configured
    backup = upload(client, agent, b"").json()
    with app.state.store.transaction() as db:
        db.execute("UPDATE backups SET status='failed'")
        db.execute("UPDATE backup_transfers SET status='failed'")
    seed_backups(app, site_id, 100, "queued")
    result = client.post(f'/api/sites/{site_id}/backups/{backup["id"]}/retry', headers=admin, json={})
    assert result.status_code == 409
    with app.state.store.transaction() as db:
        assert db.execute("SELECT status FROM backups WHERE id=?", (backup["id"],)).fetchone()[0] == "failed"
        assert db.execute("SELECT status FROM backup_transfers").fetchone()[0] == "failed"


def test_destination_and_target_count_limits(client, admin, configured, app):
    site_id, agent, first = configured
    ids = [first["id"]] + [str(uuid4()) for _ in range(99)]
    with app.state.store.transaction() as db:
        db.executemany("INSERT INTO backup_destinations VALUES(?,?,?,'',1,?)",
                       [(key, "destination", "cloud", "2030-01-01T00:00:00Z") for key in ids[1:]])
    assert client.post("/api/backup-destinations", headers=admin, json={"name": "overflow", "remote": "cloud"}).status_code == 409
    config_path = f"/api/sites/{site_id}/backup-config"
    assert client.put(config_path, headers=admin, json={"enabled": True, "destination_ids": ids[:21]}).status_code == 422
    assert client.put(config_path, headers=admin, json={"enabled": True, "destination_ids": ids[:20]}).status_code == 200
    req = client.post(f"/api/sites/{site_id}/backups/request", headers=admin, json={})
    assert req.status_code == 201
    with app.state.store.transaction() as db:
        import json
        targets = json.loads(db.execute("SELECT targets FROM backup_requests").fetchone()[0])
        assert len(targets) == 20
        # Defensive read-time bound also covers pre-existing/legacy configuration.
        db.execute("INSERT INTO backup_targets VALUES(?,?)", (site_id, ids[20]))
    assert client.post(f"/api/sites/{site_id}/backups/request", headers=admin, json={}).status_code == 409
    assert upload(client, agent, b"").status_code == 409


@pytest.mark.parametrize("scope,status", [("site", "failed"), ("global", "completed"), ("site", "uploading"), ("global", "uploading")])
def test_retained_file_count_includes_empty_and_inflight(client, admin, configured, app, monkeypatch, scope, status):
    site_id, agent, _ = configured
    monkeypatch.setattr("hub.backups.MAX_CACHED_PER_SITE", 2 if scope == "site" else 10)
    monkeypatch.setattr("hub.backups.MAX_CACHED_GLOBAL", 10 if scope == "site" else 3)
    count = 2 if scope == "site" else 3
    owner = site_id
    if scope == "global":
        owner = client.post("/api/sites", headers=admin, json={"name": "other", "url": "https://example.org"}).json()["site"]["id"]
    seed_backups(app, owner, count, status)
    with app.state.store.transaction() as db:
        ids = [r[0] for r in db.execute("SELECT id FROM backups")]
        if status != "uploading":
            db.execute("UPDATE backups SET local_available=1")
    if status != "uploading":
        for key in ids:
            app.state.backups.path(key).write_bytes(b"")
    result = upload(client, agent, b"")
    assert result.status_code == 409 and "cache file limit" in result.text
    storage = client.get("/api/backup-storage", headers=admin).json()
    assert storage["cached_files"] == count and storage["used_bytes"] == 0
    assert storage["max_cached_files"] == (10 if scope == "site" else 3)
    if status == "uploading":
        with app.state.store.transaction() as db:
            db.execute("UPDATE backups SET status='failed' WHERE id=?", (ids[0],))
    else:
        assert client.delete(f"/api/sites/{owner}/backups/{ids[0]}/local", headers=admin).status_code == 204
    assert upload(client, agent, b"").status_code == 201


def test_metadata_prunes_only_terminal_uncached_unreferenced_history(client, admin, configured, app, monkeypatch):
    site_id, agent, destination = configured
    monkeypatch.setattr("hub.backups.MAX_METADATA_PER_SITE", 5)
    old, pending, cached = [str(uuid4()) for _ in range(3)]
    old_request, pending_request = str(uuid4()), str(uuid4())
    old_transfer = str(uuid4())
    with app.state.store.transaction() as db:
        for key, request_id, available, created in ((old, old_request, 0, "2000"), (pending, pending_request, 0, "2010"), (cached, None, 1, "2020")):
            db.execute("INSERT INTO backups(id,site_id,filename,status,source,created_at,local_available,request_id) VALUES(?,?,?,'failed','direct',?,?,?)", (key, site_id, "empty", created, available, request_id))
        for key, backup, status in ((old_request, old, "uploaded"), (pending_request, pending, "pending")):
            db.execute("INSERT INTO backup_requests(id,site_id,status,created_at,backup_id,targets) VALUES(?,?,?,?,?,'[]')", (key, site_id, status, "2000", backup))
        db.execute("INSERT INTO backup_transfers(id,backup_id,destination_id,destination_name,remote,folder,remote_path,status) VALUES(?,?,?,'old','cloud','','old','completed')", (old_transfer, old, destination["id"]))
    app.state.backups.path(cached).write_bytes(b"")
    assert upload(client, agent, b"").status_code == 201
    with app.state.store.transaction() as db:
        assert not db.execute("SELECT 1 FROM backups WHERE id=?", (old,)).fetchone()
        assert not db.execute("SELECT 1 FROM backup_requests WHERE id=?", (old_request,)).fetchone()
        assert not db.execute("SELECT 1 FROM backup_transfers WHERE id=?", (old_transfer,)).fetchone()
        assert db.execute("SELECT 1 FROM backups WHERE id=?", (pending,)).fetchone()
        assert db.execute("SELECT 1 FROM backup_requests WHERE id=?", (pending_request,)).fetchone()
        assert db.execute("SELECT 1 FROM backups WHERE id=?", (cached,)).fetchone()
        assert list(db.execute("PRAGMA foreign_key_check")) == []
    assert app.state.backups.path(cached).exists()


@pytest.mark.parametrize("scope", ["site", "global"])
def test_metadata_cap_rejects_when_no_safe_pruning_and_counts_requests(client, admin, configured, app, monkeypatch, scope):
    site_id, agent, _ = configured
    monkeypatch.setattr("hub.backups.MAX_METADATA_PER_SITE", 2 if scope == "site" else 10)
    monkeypatch.setattr("hub.backups.MAX_METADATA_GLOBAL", 10 if scope == "site" else 2)
    owner = site_id
    if scope == "global":
        owner = client.post("/api/sites", headers=admin, json={"name": "other", "url": "https://example.org"}).json()["site"]["id"]
    with app.state.store.transaction() as db:
        db.executemany("INSERT INTO backup_requests(id,site_id,created_at,targets) VALUES(?,?,'2000','[]')", [(str(uuid4()), owner) for _ in range(2)])
    result = upload(client, agent, b"")
    assert result.status_code == 409 and "history limit" in result.text and "evict" in result.text
    assert client.post(f"/api/sites/{site_id}/backups/request", headers=admin, json={}).status_code == 409
    with app.state.store.transaction() as db:
        assert db.execute("SELECT COUNT(*) FROM backups").fetchone()[0] == 0
        db.execute("UPDATE backup_requests SET status='failed'")
    # Terminal, standalone requests become safely prunable without site deletion.
    assert client.post(f"/api/sites/{site_id}/backups/request", headers=admin, json={}).status_code == 201
    with app.state.store.transaction() as db:
        assert db.execute("SELECT COUNT(*) FROM backup_requests").fetchone()[0] <= 2


@pytest.mark.parametrize("result_code", [0, 1])
def test_worker_retries_finalization_without_recopy_or_new_claim(client, admin, configured, app, monkeypatch, result_code):
    site_id, agent, _ = configured
    first = upload(client, agent).json()
    second = upload(client, agent).json()
    calls = []
    fake_process(monkeypatch, [result_code, 0], calls)
    service = app.state.backups
    original = app.state.store.transaction
    failed, retrying, allow = threading.Event(), threading.Event(), threading.Event()
    failures = []

    @contextmanager
    def transient_transaction():
        if threading.current_thread().name == "hub-backup-worker" and service.pending_result is not None:
            if not failures:
                failures.append(True)
                failed.set()
                raise sqlite3.OperationalError("private diagnostic")
            retrying.set()
            assert allow.wait(5)
        with original() as db:
            yield db

    monkeypatch.setattr(app.state.store, "transaction", transient_transaction)
    service.enabled = True
    service.start()
    try:
        assert failed.wait(3) and retrying.wait(3)
        rows = {b["id"]: b for b in history(client, admin, site_id)["backups"]}
        assert rows[first["id"]]["status"] == "transferring"
        assert rows[second["id"]]["status"] == "queued"
        assert len(calls) == 1
        journals = list(service.root.glob("*.result"))
        assert len(journals) == 1 and stat.S_IMODE(journals[0].stat().st_mode) == 0o600
        allow.set()
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            rows = {b["id"]: b for b in history(client, admin, site_id)["backups"]}
            if rows[second["id"]]["status"] == "completed":
                break
            time.sleep(0.01)
        assert rows[second["id"]]["status"] == "completed"
        assert rows[first["id"]]["status"] == ("completed" if result_code == 0 else "queued")
        assert rows[first["id"]]["transfers"][0]["attempts"] == 1
        assert len(calls) == 2 and not list(service.root.glob("*.result"))
    finally:
        allow.set()
        service.stop()


def test_result_journal_replays_after_restart_without_recopy(client, admin, configured, app, monkeypatch):
    site_id, agent, _ = configured
    backup = upload(client, agent).json()
    service = app.state.backups
    calls = []
    fake_process(monkeypatch, [0], calls)
    original = app.state.store.transaction

    @contextmanager
    def broken_finalization():
        if service.pending_result is not None:
            raise sqlite3.OperationalError("temporary failure")
        with original() as db:
            yield db

    with monkeypatch.context() as patch:
        patch.setattr(app.state.store, "transaction", broken_finalization)
        with pytest.raises(sqlite3.OperationalError):
            service.transfer_one()
    assert len(calls) == 1 and list(service.root.glob("*.result"))
    replacement = create_app(data_dir=service.root.parent, admin_password="test-password")
    replacement.state.backups.recover()
    assert not list(service.root.glob("*.result"))
    assert not replacement.state.backups.transfer_one()
    assert len(calls) == 1
    assert history(client, admin, site_id)["backups"][0]["status"] == "completed"
    assert app.state.backups.path(backup["id"]).exists()


@pytest.mark.parametrize("block", ["fsync", "database"])
def test_upload_blocking_persistence_keeps_health_responsive(client, admin, configured, app, monkeypatch, block):
    from hub.backups import UploadSession

    _, agent, _ = configured
    entered, release = threading.Event(), threading.Event()
    if block == "fsync":
        original = os.fsync

        def slow_fsync(fd):
            entered.set()
            assert release.wait(5)
            return original(fd)

        monkeypatch.setattr("hub.backups.os.fsync", slow_fsync)
    else:
        original = UploadSession.write

        def blocked_database(session, chunk):
            with app.state.store.lock:
                entered.set()
                assert release.wait(5)
                return original(session, chunk)

        monkeypatch.setattr(UploadSession, "write", blocked_database)

    async def run():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as async_client:
            start = time.monotonic()
            uploading = asyncio.create_task(async_client.post("/api/agent/backups/upload?filename=empty", headers={**agent, "Content-Type": "application/octet-stream"}, content=b"data"))
            try:
                assert await anyio.to_thread.run_sync(entered.wait, 2)
                assert not uploading.done()
                response = await asyncio.wait_for(async_client.get("/api/health"), 0.5)
                assert response.status_code == 200 and time.monotonic() - start < 1
            finally:
                release.set()
                response = await uploading
            assert response.status_code == 201, response.text

    asyncio.run(run())


@pytest.mark.parametrize("phase", ["begin", "write"])
def test_native_cancellation_waits_for_persistence_then_cleans(client, admin, configured, app, monkeypatch, phase):
    from hub.backups import UploadSession

    site_id, _, _ = configured
    request_id = client.post(f"/api/sites/{site_id}/backups/request", headers=admin, json={}).json()["id"]
    endpoint = next(r.endpoint for r in app.routes if getattr(r, "path", None) == "/api/agent/backups/upload")
    original = getattr(UploadSession, phase)
    entered, release = threading.Event(), threading.Event()

    def paused(session, *args):
        result = original(session, *args)
        entered.set()
        assert release.wait(5)
        return result

    monkeypatch.setattr(UploadSession, phase, paused)

    class Body:
        headers = {"content-type": "application/octet-stream"}

        async def stream(self):
            yield b"reserved bytes"

    async def run():
        task = asyncio.create_task(endpoint(Body(), site_id, "cancel", UUID(request_id), "on_demand"))
        assert await anyio.to_thread.run_sync(entered.wait, 2)
        task.cancel()
        await asyncio.sleep(0.01)
        assert not task.done()  # No abandoned thread racing cleanup.
        task.cancel()  # Repeated cancellation cannot bypass the drain either.
        release.set()
        with pytest.raises(asyncio.CancelledError):
            await task

    from uuid import UUID
    asyncio.run(run())
    assert not list(app.state.backups.root.glob("*.part"))
    assert not list(app.state.backups.root.glob("*.blob"))
    with app.state.store.transaction() as db:
        assert app.state.backups.used(db) == 0 and app.state.backups.cached_counts(db)[0] == 0
        assert db.execute("SELECT status FROM backups").fetchone()[0] == "failed"
        assert db.execute("SELECT backup_id FROM backup_requests WHERE id=?", (request_id,)).fetchone()[0] is None


def test_upload_thread_capacity_is_bounded(app):
    lock, release, full = threading.Lock(), threading.Event(), threading.Event()
    active, peak = 0, 0

    def blocked():
        nonlocal active, peak
        with lock:
            active += 1
            peak = max(peak, active)
            if active == 8:
                full.set()
        try:
            assert release.wait(5)
        finally:
            with lock:
                active -= 1

    async def run():
        tasks = [asyncio.create_task(app.state.backups.persist(blocked)) for _ in range(16)]
        try:
            assert await anyio.to_thread.run_sync(full.wait, 2)
            await asyncio.sleep(0.02)
            assert peak == 8
        finally:
            release.set()
            await asyncio.gather(*tasks)

    asyncio.run(run())


def test_artifact_count_reservation_is_atomic_for_concurrent_empty_uploads(client, admin, configured, app, monkeypatch):
    from fastapi import HTTPException

    site_id, _, _ = configured
    monkeypatch.setattr("hub.backups.MAX_CACHED_GLOBAL", 1)
    monkeypatch.setattr("hub.backups.MAX_CACHED_PER_SITE", 1)
    endpoint = next(r.endpoint for r in app.routes if getattr(r, "path", None) == "/api/agent/backups/upload")

    async def run():
        reserved, finish = asyncio.Event(), asyncio.Event()

        class Body:
            headers = {"content-type": "application/octet-stream"}

            async def stream(self):
                reserved.set()
                await finish.wait()
                yield b""

        first = asyncio.create_task(endpoint(Body(), site_id, "empty1", None, "direct"))
        try:
            await reserved.wait()
            with pytest.raises(HTTPException) as caught:
                await endpoint(Body(), site_id, "empty2", None, "direct")
            assert caught.value.status_code == 409
        finally:
            finish.set()
            result = await first
        assert result["size_bytes"] == 0 and result["status"] == "queued"

    asyncio.run(run())
    with app.state.store.transaction() as db:
        assert app.state.backups.cached_counts(db)[0] == 1
        assert db.execute("SELECT COUNT(*) FROM backups").fetchone()[0] == 1
