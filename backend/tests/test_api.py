import hashlib
import stat
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from uuid import uuid4

import pytest
from cryptography.fernet import Fernet
from fastapi.testclient import TestClient
from itsdangerous import TimestampSigner

from hub.app import MAX_BODY, create_app, persistent_key


def make_site(client, admin, name="Other"):
    data = client.post("/api/sites", json={"name": name, "url": "https://other.example"}, headers=admin).json()
    return data["site"]["id"], {"Authorization": f"Bearer {data['agent_token']}"}


def test_required_password_and_bad_key(tmp_path, monkeypatch):
    monkeypatch.delenv("HUB_ADMIN_PASSWORD", raising=False)
    with pytest.raises(RuntimeError, match="HUB_ADMIN_PASSWORD"):
        create_app(data_dir=tmp_path)
    with pytest.raises(RuntimeError, match="HUB_ADMIN_PASSWORD"):
        create_app(data_dir=tmp_path, admin_password="   ")
    with pytest.raises(RuntimeError, match="Fernet"):
        create_app(data_dir=tmp_path, admin_password="x", encryption_key="bad-key")


def test_auth_and_scope(client, admin, site):
    site_id, agent = site
    assert client.get("/api/health").json() == {"status": "ok"}
    assert client.get("/api/sites").status_code == 401
    assert client.get("/api/sites", headers={"Authorization": "Bearer fake"}).status_code == 401
    assert client.get("/api/sites", headers=agent).status_code == 401
    assert client.get("/api/agent/config", headers=admin).status_code == 401
    assert client.post("/api/auth/login", json={"password": "wrong"}).status_code == 401
    result = client.get("/api/sites", headers=admin)
    assert result.status_code == 200
    assert "token" not in result.text and "hash" not in result.text
    assert client.get(f"/api/sites/{uuid4()}", headers=admin).status_code == 404
    assert client.get("/api/sites/not-a-uuid", headers=admin).status_code == 422


def test_expiry(client, monkeypatch):
    timestamp = TimestampSigner.get_timestamp
    monkeypatch.setattr(TimestampSigner, "get_timestamp", lambda self: timestamp(self) - 28801)
    token = client.post("/api/auth/login", json={"password": "test-password"}).json()["access_token"]
    monkeypatch.setattr(TimestampSigner, "get_timestamp", timestamp)
    assert client.get("/api/sites", headers={"Authorization": f"Bearer {token}"}).status_code == 401


def test_login_throttling(client):
    for _ in range(10):
        assert client.post("/api/auth/login", json={"password": "wrong"}).status_code == 401
    result = client.post("/api/auth/login", json={"password": "test-password"})
    assert result.status_code == 429
    assert result.headers["retry-after"] == "60"


def test_sites_crud(client, admin, site):
    site_id, _ = site
    before = client.get(f"/api/sites/{site_id}", headers=admin).json()
    assert before["status"] == "offline"
    assert before["desired_state"] == "stopped"
    assert before["last_seen"] is None
    assert before["worker_count"] == 0
    assert before["created_at"].endswith("Z")
    data = {"name": "Robert'); DROP TABLE sites;--", "description": "updated", "url": "http://localhost:1234/path"}
    result = client.patch(f"/api/sites/{site_id}", headers=admin, json=data)
    assert result.status_code == 200
    assert result.json()["name"] == data["name"]
    assert client.patch(f"/api/sites/{site_id}", headers=admin, json={"name": None}).status_code == 422
    assert client.patch(f"/api/sites/{site_id}", headers=admin, json={}).status_code == 200
    assert client.delete(f"/api/sites/{site_id}", headers=admin).status_code == 204
    assert client.get(f"/api/sites/{site_id}", headers=admin).status_code == 404


@pytest.mark.parametrize("url", ["file:///etc/passwd", "ftp://example.com", "javascript:alert(1)", "https://user:password@example.com", "https://example.com:99999", "https://example.com/#frag", "https://exa mple.com", "http://example.com\\@evil.com", "https://"])
def test_site_url_validation(client, admin, url):
    assert client.post("/api/sites", headers=admin, json={"name": "bad", "url": url}).status_code == 422


def test_heartbeat_replacement_and_status(client, admin, site, app):
    site_id, agent = site
    worker_id = str(uuid4())
    worker = {"id": worker_id, "name": "worker", "status": "running", "cpu_percent": 33.5, "memory_mb": 64, "tasks_completed": 10}
    beat = client.post("/api/agent/heartbeat", headers=agent, json={"status": "healthy", "workers": [worker]})
    assert beat.status_code == 200
    assert beat.json()["site_id"] == site_id
    assert beat.json()["desired_state"] == "stopped"
    output = client.get(f"/api/sites/{site_id}", headers=admin).json()
    assert output["status"] == "healthy"
    assert output["worker_count"] == output["healthy_workers"] == 1
    workers = client.get(f"/api/sites/{site_id}/workers", headers=admin).json()
    assert workers[0]["cpu_percent"] == 33.5
    assert "site_id" not in workers[0]
    overview = client.get("/api/overview", headers=admin).json()
    assert overview["summary"] == {"sites": 1, "healthy": 1, "workers": 1, "running": 1}
    worker["status"] = "error"
    client.post("/api/agent/heartbeat", headers=agent, json={"status": "healthy", "workers": [worker]})
    assert client.get(f"/api/sites/{site_id}", headers=admin).json()["status"] == "degraded"
    client.post("/api/agent/heartbeat", headers=agent, json={"status": "degraded", "workers": []})
    assert client.get(f"/api/sites/{site_id}/workers", headers=admin).json() == []
    assert client.get(f"/api/sites/{site_id}", headers=admin).json()["status"] == "degraded"
    with app.state.store.transaction() as db:
        db.execute("UPDATE sites SET last_seen=? WHERE id=?", ((datetime.now(timezone.utc) - timedelta(seconds=61)).isoformat(), site_id))
    assert client.get(f"/api/sites/{site_id}", headers=admin).json()["status"] == "offline"


def test_invalid_heartbeat_is_atomic(client, admin, site):
    site_id, agent = site
    worker = {"id": str(uuid4()), "name": "one", "status": "idle"}
    assert client.post("/api/agent/heartbeat", headers=agent, json={"status": "healthy", "workers": [worker]}).status_code == 200
    invalid = [
        {"status": "healthy", "workers": [worker, worker]},
        {"status": "bad", "workers": []},
        {"status": "healthy", "workers": [{**worker, "cpu_percent": 100001}]},
        {"status": "healthy", "workers": [{**worker, "memory_mb": -1}]},
        {"status": "healthy", "workers": [{**worker, "tasks_completed": -1}]},
        {"status": "healthy", "workers": [{**worker, "id": "nope"}]},
        {"status": "healthy", "workers": [{**worker, "id": str(uuid4())} for _ in range(101)]},
    ]
    for payload in invalid:
        assert client.post("/api/agent/heartbeat", headers=agent, json=payload).status_code == 422
    assert len(client.get(f"/api/sites/{site_id}/workers", headers=admin).json()) == 1


def test_config_secret_preservation_and_clear(client, admin, site, app):
    site_id, agent = site
    path = f"/api/sites/{site_id}/config"
    assert client.get(path, headers=admin).json()["has_ai_api_key"] is False
    result = client.put(path, headers=admin, json={"number_of_workers": 5, "ai_preset_id": "preset", "ai_api_key": "ai-secret-123", "captcha_api_key": "captcha-secret-456"})
    assert result.status_code == 200
    assert result.json()["has_ai_api_key"] and result.json()["has_captcha_api_key"]
    assert "secret" not in result.text
    assert "ai_api_key" not in {k for k in result.json() if not k.startswith("has_")}
    assert client.get("/api/agent/config", headers=agent).json()["ai_api_key"] == "ai-secret-123"
    client.put(path, headers=admin, json={"number_of_workers": 2, "ai_preset_id": "new", "captcha_api_key": ""})
    cfg = client.get("/api/agent/config", headers=agent).json()
    assert cfg["ai_api_key"] == "ai-secret-123"
    assert cfg["captcha_api_key"] == ""
    for n in [-1, 101, 2.5, True, "2"]:
        assert client.put(path, headers=admin, json={"number_of_workers": n, "ai_preset_id": "default"}).status_code == 422
    assert client.put(path, headers=admin, json={"number_of_workers": 1, "ai_preset_id": "default", "ai_api_key": None}).status_code == 422
    with app.state.store.transaction() as db:
        encrypted = db.execute("SELECT ai_api_key FROM configs WHERE site_id=?", (site_id,)).fetchone()[0]
    assert encrypted.startswith("gAAAA") and "ai-secret-123" not in encrypted
    assert b"ai-secret-123" not in app.state.store.path.read_bytes()


def test_proxies_and_site_isolation(client, admin, site):
    site_id, agent = site
    other_id, other_agent = make_site(client, admin)
    path = f"/api/sites/{site_id}/proxies"
    result = client.post(path, headers=admin, json={"url": "socks5://127.0.0.1:1080", "username": "user", "password": "proxy-secret"})
    assert result.status_code == 201
    proxy = result.json()
    assert proxy["has_password"] is True and "password" not in proxy
    assert "proxy-secret" not in client.get(path, headers=admin).text
    assert client.get("/api/agent/config", headers=agent).json()["proxies"][0]["password"] == "proxy-secret"
    assert client.get("/api/agent/config", headers=other_agent).json()["proxies"] == []
    assert client.delete(f"/api/sites/{other_id}/proxies/{proxy['id']}", headers=admin).status_code == 404
    for url in ["http://u:p@host:80", "socks4://localhost:123", "file:///foo", "http://host:99999"]:
        assert client.post(path, headers=admin, json={"url": url}).status_code == 422
    assert client.delete(f"{path}/{proxy['id']}", headers=admin).status_code == 204
    assert client.get(path, headers=admin).json() == []


def test_commands_at_least_once_and_ack(client, admin, site):
    site_id, agent = site
    _, other_agent = make_site(client, admin)
    path = f"/api/sites/{site_id}/commands"
    command = client.post(path, headers=admin, json={"action": "start"}).json()
    assert command["status"] == "pending" and command["completed_at"] is None
    assert client.get(f"/api/sites/{site_id}", headers=admin).json()["desired_state"] == "running"
    assert client.get("/api/agent/commands", headers=other_agent).json() == []
    ack_path = f"/api/agent/commands/{command['id']}/ack"
    assert client.post(ack_path, headers=other_agent, json={"status": "completed"}).status_code == 404
    first = client.get("/api/agent/commands", headers=agent).json()
    assert first[0]["status"] == "delivered"
    assert client.get("/api/agent/commands", headers=agent).json() == first
    ack = client.post(ack_path, headers=agent, json={"status": "completed", "message": "done"}).json()
    assert ack["status"] == "completed" and ack["completed_at"] is not None
    assert client.post(ack_path, headers=agent, json={"status": "completed", "message": "different"}).json() == ack
    assert client.post(ack_path, headers=agent, json={"status": "failed"}).status_code == 409
    assert client.get("/api/agent/commands", headers=agent).json() == []


def test_commands_supersede_and_latest_twenty(client, admin, site):
    site_id, agent = site
    path = f"/api/sites/{site_id}/commands"
    first = client.post(path, headers=admin, json={"action": "start"}).json()
    client.get("/api/agent/commands", headers=agent)
    second = client.post(path, headers=admin, json={"action": "stop"}).json()
    polled = client.get("/api/agent/commands", headers=agent).json()
    assert [c["id"] for c in polled] == [second["id"]]
    assert client.get(f"/api/sites/{site_id}", headers=admin).json()["desired_state"] == "stopped"
    assert client.post(f"/api/agent/commands/{first['id']}/ack", headers=agent, json={"status": "completed"}).status_code == 409
    history = client.get(path, headers=admin).json()
    assert history[1]["status"] == "failed" and "Superseded" in history[1]["message"]
    for _ in range(22):
        assert client.post(path, headers=admin, json={"action": "restart"}).status_code == 201
    assert len(client.get(path, headers=admin).json()) == 20
    assert client.get(f"/api/sites/{site_id}", headers=admin).json()["desired_state"] == "running"
    assert client.post(path, headers=admin, json={"action": "exec", "command": "ls"}).status_code == 422


def test_errors_scope_limits_and_cascade(client, admin, site, app):
    site_id, agent = site
    other_id, other_agent = make_site(client, admin)
    result = client.post("/api/agent/errors", headers=agent, json={"worker_id": str(uuid4()), "level": "error", "message": "safe error"})
    assert result.status_code == 201
    errors = client.get(f"/api/sites/{site_id}/errors", headers=admin).json()
    assert errors[0]["id"] == result.json()["id"]
    assert errors[0]["site_name"] == "Site one" and errors[0]["site_id"] == site_id
    assert client.get(f"/api/sites/{other_id}/errors", headers=admin).json() == []
    assert len(client.get("/api/overview", headers=admin).json()["recent_errors"]) == 1
    for limit in [0, -1, 1001, "not-a-number"]:
        assert client.get(f"/api/sites/{site_id}/errors?limit={limit}", headers=admin).status_code == 422
    assert client.post("/api/agent/errors", headers=agent, json={"level": "debug", "message": "bad"}).status_code == 422
    client.post(f"/api/sites/{site_id}/commands", headers=admin, json={"action": "start"})
    client.post(f"/api/sites/{site_id}/proxies", headers=admin, json={"url": "https://proxy.example"})
    client.delete(f"/api/sites/{site_id}", headers=admin)
    assert client.get("/api/agent/config", headers=agent).status_code == 401
    with app.state.store.transaction() as db:
        for table in ("configs", "workers", "errors", "commands", "proxies"):
            assert db.execute(f"SELECT COUNT(*) FROM {table} WHERE site_id=?", (site_id,)).fetchone()[0] == 0


def test_token_rotation_and_hashed_storage(client, admin, site, app):
    site_id, agent = site
    old = agent["Authorization"].split()[1]
    with app.state.store.transaction() as db:
        stored = db.execute("SELECT token_hash FROM sites WHERE id=?", (site_id,)).fetchone()[0]
    assert stored == hashlib.sha256(old.encode()).hexdigest()
    assert old.encode() not in app.state.store.path.read_bytes()
    result = client.post(f"/api/sites/{site_id}/agent-token", headers=admin)
    assert result.status_code == 200
    new = {"Authorization": f"Bearer {result.json()['agent_token']}"}
    assert client.get("/api/agent/config", headers=agent).status_code == 401
    assert client.get("/api/agent/config", headers=new).status_code == 200


def test_persistence_keys_auth_secrets_and_commands(tmp_path):
    directory = tmp_path / "persistent"
    app = create_app(data_dir=directory, admin_password="secret")
    with TestClient(app) as client:
        token = client.post("/api/auth/login", json={"password": "secret"}).json()["access_token"]
        admin = {"Authorization": f"Bearer {token}"}
        site_id, agent = make_site(client, admin)
        client.put(f"/api/sites/{site_id}/config", headers=admin, json={"number_of_workers": 1, "ai_preset_id": "default", "ai_api_key": "persistent-secret"})
        command = client.post(f"/api/sites/{site_id}/commands", headers=admin, json={"action": "restart"}).json()
        client.get("/api/agent/commands", headers=agent)
    encryption_key = (directory / "encryption.key").read_bytes()
    signing_key = (directory / "signing.key").read_bytes()
    with TestClient(create_app(data_dir=directory, admin_password="secret")) as client:
        assert client.get("/api/sites", headers=admin).status_code == 200
        assert client.get("/api/agent/config", headers=agent).json()["ai_api_key"] == "persistent-secret"
        assert client.get("/api/agent/commands", headers=agent).json()[0]["id"] == command["id"]
    assert (directory / "encryption.key").read_bytes() == encryption_key
    assert (directory / "signing.key").read_bytes() == signing_key
    assert stat.S_IMODE(directory.stat().st_mode) == 0o700
    for name in ("encryption.key", "signing.key", "hub.sqlite3"):
        assert stat.S_IMODE((directory / name).stat().st_mode) == 0o600


def test_env_encryption_key(tmp_path, monkeypatch):
    key = Fernet.generate_key()
    monkeypatch.setenv("HUB_ENCRYPTION_KEY", key.decode())
    create_app(data_dir=tmp_path, admin_password="secret")
    assert not (tmp_path / "encryption.key").exists()


def test_invalid_persistent_key_not_overwritten(tmp_path):
    key_path = tmp_path / "encryption.key"
    key_path.write_text("invalid")
    with pytest.raises(RuntimeError, match="Fernet"):
        create_app(data_dir=tmp_path, admin_password="secret")
    assert key_path.read_text() == "invalid"


def test_validation_never_echoes_secrets(client, admin, site):
    site_id, _ = site
    secret = "DO-NOT-ECHO-THIS"
    result = client.put(f"/api/sites/{site_id}/config", headers=admin, json={"number_of_workers": -1, "ai_preset_id": "default", "ai_api_key": secret, "captcha_api_key": secret})
    assert result.status_code == 422 and secret not in result.text
    result = client.post("/api/auth/login", json={"password": secret, "unknown": secret})
    assert result.status_code == 422 and secret not in result.text
    result = client.post(f"/api/sites/{site_id}/proxies", headers=admin, json={"url": f"http://user:{secret}@host"})
    assert result.status_code == 422 and secret not in result.text


def test_body_limit(client):
    response = client.post("/api/auth/login", content=b"x" * (MAX_BODY + 1))
    assert response.status_code == 413
    assert client.get("/api/health").status_code == 200


def test_cors_default(client):
    response = client.get("/api/health", headers={"Origin": "https://evil.example"})
    assert "access-control-allow-origin" not in response.headers
    assert response.headers["cache-control"] == "no-store"


def test_explicit_cors(tmp_path, monkeypatch):
    monkeypatch.setenv("HUB_CORS_ORIGINS", "https://dashboard.example,http://localhost:5173")
    with TestClient(create_app(data_dir=tmp_path, admin_password="secret")) as client:
        assert client.get("/api/health", headers={"Origin": "https://dashboard.example"}).headers["access-control-allow-origin"] == "https://dashboard.example"
        assert "access-control-allow-origin" not in client.get("/api/health", headers={"Origin": "https://evil.example"}).headers
    monkeypatch.setenv("HUB_CORS_ORIGINS", "*")
    with pytest.raises((ValueError, RuntimeError)):
        create_app(data_dir=tmp_path, admin_password="secret")


def test_static_spa_and_api_fallback(tmp_path):
    frontend = tmp_path / "frontend"
    frontend.mkdir()
    (frontend / "index.html").write_text("<h1>Dashboard</h1>")
    (frontend / "assets").mkdir()
    (frontend / "assets" / "app.js").write_text("console.log('ok')")
    with TestClient(create_app(data_dir=tmp_path / "data", admin_password="secret", frontend_dir=frontend)) as client:
        assert client.get("/").text == "<h1>Dashboard</h1>"
        assert client.get("/sites/some-id").text == "<h1>Dashboard</h1>"
        assert client.get("/assets/app.js").status_code == 200
        for path in ("/api", "/api/unknown", "/api/sites/unknown/extra", "/assets/missing.js", "/missing.css", "/%2e%2e/secret"):
            assert client.get(path).status_code == 404
        assert client.post("/api/unknown", json={}).status_code in (404, 405)


def test_concurrent_commands_are_consistent(client, admin, site):
    site_id, agent = site
    path = f"/api/sites/{site_id}/commands"
    with ThreadPoolExecutor(max_workers=8) as executor:
        results = list(executor.map(lambda _: client.post(path, headers=admin, json={"action": "restart"}), range(20)))
    assert all(r.status_code == 201 for r in results)
    history = client.get(path, headers=admin).json()
    assert sum(c["status"] == "pending" for c in history) == 1
    assert sum(c["status"] == "failed" for c in history) == 19
    assert len(client.get("/api/agent/commands", headers=agent).json()) == 1


def test_history_is_bounded(client, admin, site, monkeypatch):
    monkeypatch.setattr("hub.app.MAX_HISTORY", 3)
    site_id, agent = site
    for i in range(6):
        client.post("/api/agent/errors", headers=agent, json={"level": "error", "message": str(i)})
        client.post(f"/api/sites/{site_id}/commands", headers=admin, json={"action": "start"})
    assert len(client.get(f"/api/sites/{site_id}/errors", headers=admin).json()) == 3
    assert len(client.get(f"/api/sites/{site_id}/commands", headers=admin).json()) == 3


def test_site_and_proxy_limits(client, admin, site, monkeypatch):
    site_id, _ = site
    monkeypatch.setattr("hub.app.MAX_SITES", 1)
    monkeypatch.setattr("hub.app.MAX_PROXIES", 1)
    assert client.post("/api/sites", headers=admin, json={"name": "Too many", "url": "https://example.org"}).status_code == 409
    path = f"/api/sites/{site_id}/proxies"
    assert client.post(path, headers=admin, json={"url": "https://proxy.example"}).status_code == 201
    assert client.post(path, headers=admin, json={"url": "https://proxy.example"}).status_code == 409


def test_atomic_first_key_creation(tmp_path):
    key_path = tmp_path / "key"
    with ThreadPoolExecutor(max_workers=10) as executor:
        values = list(executor.map(lambda _: persistent_key(key_path, Fernet.generate_key), range(50)))
    assert len(set(values)) == 1
    assert list(tmp_path.iterdir()) == [key_path]


def test_wrong_encryption_key_fails_closed(tmp_path):
    key = Fernet.generate_key()
    app = create_app(data_dir=tmp_path, admin_password="secret", encryption_key=key)
    with TestClient(app) as client:
        token = client.post("/api/auth/login", json={"password": "secret"}).json()["access_token"]
        admin = {"Authorization": f"Bearer {token}"}
        site_id, _ = make_site(client, admin)
        assert client.put(f"/api/sites/{site_id}/config", headers=admin, json={"number_of_workers": 1, "ai_preset_id": "default", "ai_api_key": "encrypted"}).status_code == 200
    with pytest.raises(RuntimeError, match="Stored secrets cannot be decrypted"):
        create_app(data_dir=tmp_path, admin_password="secret", encryption_key=Fernet.generate_key())
    create_app(data_dir=tmp_path, admin_password="secret", encryption_key=key)


def test_streamed_body_limit(app):
    import asyncio

    async def exercise():
        messages = []
        chunks = iter([
            {"type": "http.request", "body": b"x" * (MAX_BODY // 2), "more_body": True},
            {"type": "http.request", "body": b"x" * (MAX_BODY // 2 + 1), "more_body": False},
        ])

        async def receive():
            return next(chunks)

        async def send(message):
            messages.append(message)

        await app({"type": "http", "http_version": "1.1", "scheme": "http", "method": "POST", "path": "/api/auth/login", "raw_path": b"/api/auth/login", "query_string": b"", "root_path": "", "headers": [(b"content-type", b"application/json")], "client": ("localhost", 123), "server": ("localhost", 80)}, receive, send)
        assert messages[0]["status"] == 413

    asyncio.run(exercise())
