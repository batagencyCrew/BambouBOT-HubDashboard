from concurrent.futures import ThreadPoolExecutor
import sqlite3
import threading
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from hub.app import Storage, create_app


SYNC = "/api/agent/local-sync"


def current(client, agent):
    response = client.get("/api/agent/config", headers=agent)
    assert response.status_code == 200
    return response.json()


def sync(client, agent, revision=0, **fields):
    return client.post(SYNC, headers=agent, json={"expected_revision": revision, **fields})


def flags(app, site_id):
    with app.state.store.transaction() as db:
        return tuple(db.execute("SELECT revision,admin_modified,local_sync_initialized FROM configs WHERE site_id=?", (site_id,)).fetchone())


def test_pristine_import_encryption_and_idempotency(client, admin, site, app):
    site_id, agent = site
    assert current(client, agent)["revision"] == 0
    assert current(client, agent)["local_sync_initialized"] is False
    response = sync(client, agent, config={"ai_api_key": "local-ai-secret", "number_of_workers": 100, "ai_preset_id": "local"},
                    proxies_content="# comment\nhttp://user:p%40ss%3Aword@HOST:80\nuser:p%40ss:word@host:80\nsocks5://[::1]:1080")
    assert response.status_code == 200
    value = response.json()
    assert set(value) == {"number_of_workers", "ai_preset_id", "ai_api_key", "captcha_api_key", "proxies", "revision", "local_sync_initialized"}
    assert value["ai_api_key"] == "local-ai-secret"
    assert value["number_of_workers"] == 100 and value["ai_preset_id"] == "local"
    assert value["captcha_api_key"] == ""
    assert len(value["proxies"]) == 2
    assert any(p["password"] == "p@ss:word" and p["url"] == "http://host:80" for p in value["proxies"])
    assert flags(app, site_id) == (1, 0, 1)
    assert current(client, agent) == value
    assert sync(client, agent, 1, config={"ai_api_key": "ignored"}, proxies_content="invalid file").json() == value
    assert sync(client, agent).status_code == 409
    assert flags(app, site_id) == (1, 0, 1)
    assert client.get(f"/api/sites/{site_id}/config", headers=admin).json()["revision"] == 1
    with app.state.store.transaction() as db:
        assert db.execute("SELECT ai_api_key FROM configs WHERE site_id=?", (site_id,)).fetchone()[0].startswith("gAAAA")
        assert any(row[0].startswith("gAAAA") for row in db.execute("SELECT password FROM proxies"))
    assert b"local-ai-secret" not in app.state.store.path.read_bytes()
    assert b"p@ss:word" not in app.state.store.path.read_bytes()


@pytest.mark.parametrize("fields", [{}, {"config": {}, "proxies_content": ""}, {"proxies_content": "\ufeff# comments\r\n\n"},
                                     {"config": {"number_of_workers": 0}}, {"config": {"ai_api_key": "config-only"}}])
def test_empty_and_config_only_enrollment(client, site, app, fields):
    site_id, agent = site
    result = sync(client, agent, **fields)
    assert result.status_code == 200
    assert result.json()["proxies"] == []
    assert result.json()["number_of_workers"] == fields.get("config", {}).get("number_of_workers", 1)
    assert result.json()["ai_api_key"] == fields.get("config", {}).get("ai_api_key", "")
    assert flags(app, site_id) == (1, 0, 1)


def test_proxy_only_enrollment_at_capacity(client, site, app):
    site_id, agent = site
    content = "\n".join(f"host:{port}:user:password" for port in range(1, 1001))
    response = sync(client, agent, proxies_content=content)
    assert response.status_code == 200
    value = response.json()
    assert len(value["proxies"]) == 1000
    assert all(p["password"] == "password" for p in value["proxies"])
    assert value["ai_api_key"] == "" and value["number_of_workers"] == 1
    assert flags(app, site_id) == (1, 0, 1)


@pytest.mark.parametrize("body", [
    {}, {"expected_revision": -1}, {"expected_revision": True}, {"expected_revision": "0"}, {"expected_revision": 0.0},
    {"expected_revision": None}, {"expected_revision": 0, "config": None},
    {"expected_revision": 0, "config": {"captcha_api_key": "forbidden-secret"}},
    {"expected_revision": 0, "config": {"revision": 0}},
    {"expected_revision": 0, "config": {"number_of_workers": 101}},
    {"expected_revision": 0, "config": {"number_of_workers": True}},
    {"expected_revision": 0, "config": {"ai_api_key": None}},
    {"expected_revision": 0, "config": {"ai_preset_id": ""}},
    {"expected_revision": 0, "proxies_content": None},
    {"expected_revision": 0, "path": "/etc/passwd"},
    {"expected_revision": 0, "site_id": str(uuid4())},
])
def test_invalid_schema_never_mutates(client, site, app, body):
    site_id, agent = site
    before = current(client, agent)
    response = client.post(SYNC, headers=agent, json=body)
    assert response.status_code == 422
    assert "forbidden-secret" not in response.text
    assert current(client, agent) == before
    assert flags(app, site_id) == (0, 0, 0)


@pytest.mark.parametrize("content", ["host:80\nhttp://user:private-password@host:80/path", "file:///etc/passwd", "host:80\n" * 1001, "#" * (512 * 1024 + 1)])
def test_invalid_file_is_atomic_sanitized(client, site, app, content, caplog):
    site_id, agent = site
    before = current(client, agent)
    result = sync(client, agent, config={"ai_api_key": "private-key", "number_of_workers": 8}, proxies_content=content)
    assert result.status_code == 422
    assert "private-password" not in result.text + caplog.text
    assert "private-key" not in result.text + caplog.text
    assert "Invalid local sync" in caplog.text
    assert current(client, agent) == before
    assert flags(app, site_id) == (0, 0, 0)


def test_admin_revisions_and_nonmutating_paths(client, admin, site, app):
    site_id, agent = site
    path = f"/api/sites/{site_id}"
    def revision(n):
        assert current(client, agent)["revision"] == n
        assert client.get(path + "/config", headers=admin).json()["revision"] == n
    revision(0)
    assert client.put(path + "/config", headers=admin, json={"number_of_workers": 101, "ai_preset_id": "x"}).status_code == 422
    assert client.delete(path + f"/proxies/{uuid4()}", headers=admin).status_code == 404
    assert client.post(path + "/proxies", headers=admin, json={"url": "file:///etc/passwd"}).status_code == 422
    for fields in ({"content": "host:80"}, {"content": "host:80\nbad", "dry_run": False}, {"content": "", "dry_run": False}):
        assert client.post(path + "/proxies/import", headers=admin, json=fields).status_code == 200
    assert flags(app, site_id) == (0, 0, 0)
    config = {"number_of_workers": 1, "ai_preset_id": "default"}
    for n in (1, 2):
        assert client.put(path + "/config", headers=admin, json=config).status_code == 200
        revision(n)
    proxy = client.post(path + "/proxies", headers=admin, json={"url": "http://host:80"}).json()
    revision(3)
    assert client.delete(path + f"/proxies/{proxy['id']}", headers=admin).status_code == 204
    revision(4)
    assert client.delete(path + f"/proxies/{proxy['id']}", headers=admin).status_code == 404
    revision(4)
    fields = {"content": "host:80\nother:81", "dry_run": False}
    assert client.post(path + "/proxies/import", headers=admin, json=fields).json()["imported"] == 2
    revision(5)
    assert client.post(path + "/proxies/import", headers=admin, json=fields).json()["imported"] == 0
    revision(5)
    assert flags(app, site_id) == (5, 1, 0)


def test_admin_preemption_and_deleted_proxies_never_resurrect(client, admin, site, app):
    site_id, agent = site
    path = f"/api/sites/{site_id}"
    assert client.put(path + "/config", headers=admin, json={"number_of_workers": 3, "ai_preset_id": "admin", "ai_api_key": "hub", "captcha_api_key": "captcha"}).status_code == 200
    assert sync(client, agent, config={"ai_api_key": "local"}, proxies_content="host:80").status_code == 409
    assert flags(app, site_id) == (1, 1, 0)
    # Touched sites validate schema, but ignore even invalid local file content.
    assert sync(client, agent, 1, config={"captcha_api_key": "bad"}).status_code == 422
    value = sync(client, agent, 1, config={"ai_api_key": "local"}, proxies_content="invalid").json()
    assert (value["ai_api_key"], value["captcha_api_key"], value["number_of_workers"], value["proxies"]) == ("hub", "captcha", 3, [])
    proxy = client.post(path + "/proxies", headers=admin, json={"url": "http://host:80"}).json()
    assert client.delete(path + f"/proxies/{proxy['id']}", headers=admin).status_code == 204
    assert sync(client, agent, 4, proxies_content="host:80").json()["proxies"] == []
    assert client.put(path + "/config", headers=admin, json={"number_of_workers": 3, "ai_preset_id": "admin", "ai_api_key": ""}).status_code == 200
    assert current(client, agent)["ai_api_key"] == ""
    assert flags(app, site_id) == (5, 1, 1)


def test_pre_enrollment_add_delete_is_not_pristine(client, admin, site):
    site_id, agent = site
    path = f"/api/sites/{site_id}/proxies"
    proxy = client.post(path, headers=admin, json={"url": "http://host:80"}).json()
    client.delete(path + "/" + proxy["id"], headers=admin)
    value = sync(client, agent, 2, proxies_content="host:80").json()
    assert value["proxies"] == [] and value["revision"] == 3


def test_token_scope_rotation_and_deletion(client, admin, site):
    site_id, agent = site
    assert sync(client, {}).status_code == 401
    assert sync(client, admin).status_code == 401
    other = client.post("/api/sites", headers=admin, json={"name": "other", "url": "https://other.example"}).json()
    other_agent = {"Authorization": "Bearer " + other["agent_token"]}
    assert sync(client, other_agent, config={"ai_api_key": "other-secret"}).status_code == 200
    assert current(client, agent)["revision"] == 0
    assert client.put(f"/api/sites/{site_id}/config", headers=agent, json={"number_of_workers": 1, "ai_preset_id": "x"}).status_code == 401
    token = client.post(f"/api/sites/{site_id}/agent-token", headers=admin).json()["agent_token"]
    assert sync(client, agent).status_code == 401
    replacement = {"Authorization": "Bearer " + token}
    assert sync(client, replacement).status_code == 200
    assert client.delete(f"/api/sites/{site_id}", headers=admin).status_code == 204
    assert sync(client, replacement, 1).status_code == 401


def test_concurrent_enrollment_cross_app_is_atomic(client, site, app):
    site_id, agent = site
    second = create_app(data_dir=app.state.store.path.parent, admin_password="test-password")
    barrier = threading.Barrier(2)
    with TestClient(second) as other:
        def enroll(args):
            c, key = args
            barrier.wait()
            return sync(c, agent, config={"ai_api_key": key}, proxies_content=f"{key}:80")
        with ThreadPoolExecutor(2) as pool:
            results = list(pool.map(enroll, [(client, "first"), (other, "second")]))
    assert sorted(r.status_code for r in results) == [200, 409]
    value = current(client, agent)
    assert value["proxies"][0]["url"] == f"http://{value['ai_api_key']}:80"
    assert flags(app, site_id) == (1, 0, 1)


def test_admin_enrollment_race_cross_app(client, admin, site, app):
    site_id, agent = site
    second = create_app(data_dir=app.state.store.path.parent, admin_password="test-password")
    barrier = threading.Barrier(2)
    with TestClient(second) as other:
        def enroll():
            barrier.wait()
            return sync(other, agent, config={"ai_api_key": "local"})
        def write():
            barrier.wait()
            return client.put(f"/api/sites/{site_id}/config", headers=admin, json={"number_of_workers": 5, "ai_preset_id": "hub", "ai_api_key": "hub"})
        with ThreadPoolExecutor(2) as pool:
            enrollment, admin_write = pool.submit(enroll), pool.submit(write)
            result = enrollment.result()
            assert admin_write.result().status_code == 200
    assert result.status_code in (200, 409)
    value = current(client, agent)
    if result.status_code == 409:
        assert value["local_sync_initialized"] is False
        value = sync(client, agent, value["revision"]).json()
    assert value["ai_api_key"] == "hub" and value["number_of_workers"] == 5
    assert flags(app, site_id) == (2, 1, 1)


def test_legacy_migration_conservative_and_persistent(tmp_path):
    directory = tmp_path / "legacy"
    directory.mkdir()
    # A legacy empty site might have had every proxy deleted: do not infer pristine.
    with sqlite3.connect(directory / "hub.sqlite3") as db:
        db.execute("CREATE TABLE configs(site_id TEXT PRIMARY KEY,number_of_workers INTEGER NOT NULL DEFAULT 1,ai_preset_id TEXT NOT NULL DEFAULT 'default',ai_api_key TEXT NOT NULL DEFAULT '',captcha_api_key TEXT NOT NULL DEFAULT '',updated_at TEXT NOT NULL)")
        db.execute("INSERT INTO configs(site_id,updated_at) VALUES('legacy','old')")
    first = Storage(directory)
    with first.transaction() as db:
        row = db.execute("SELECT * FROM configs WHERE site_id='legacy'").fetchone()
        assert (row["revision"], row["admin_modified"], row["local_sync_initialized"]) == (0, 1, 0)
        assert row["updated_at"] == "old"
        db.execute("UPDATE configs SET revision=7,local_sync_initialized=1 WHERE site_id='legacy'")
        db.execute("INSERT INTO configs(site_id,updated_at) VALUES('new','new')")
    second = Storage(directory)
    with second.transaction() as db:
        assert tuple(db.execute("SELECT revision,admin_modified,local_sync_initialized FROM configs WHERE site_id='legacy'").fetchone()) == (7, 1, 1)
        assert tuple(db.execute("SELECT revision,admin_modified,local_sync_initialized FROM configs WHERE site_id='new'").fetchone()) == (0, 0, 0)


def test_enrollment_guard_survives_restart(client, site, app):
    _, agent = site
    assert sync(client, agent).status_code == 200
    restarted = create_app(data_dir=app.state.store.path.parent, admin_password="test-password")
    with TestClient(restarted) as other:
        value = sync(other, agent, 1, proxies_content="host:80", config={"ai_api_key": "ignored"}).json()
        assert value["proxies"] == [] and value["ai_api_key"] == "" and value["revision"] == 1
