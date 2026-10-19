from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from hub import telemetry
from hub.app import Storage, create_app
from test_api import make_site


def chat(**changes):
    return {"event_id": str(uuid4()), "worker_id": str(uuid4()), "msgs_in": 2,
            "msgs_out": 3, "links": 1, "converted": True, "duration": 3.5, **changes}


def usage(**changes):
    return {"event_id": str(uuid4()), "key_id": "primary-slot", "calls": 2,
            "error_429": 1, "error_502": 0, "latency_ms": 100, **changes}


@pytest.mark.parametrize("field,value", [
    ("event_id", "bad"), ("worker_id", "bad"), ("msgs_in", True), ("msgs_out", 1.0),
    ("msgs_in", -1), ("links", "https://example.com"), ("links", 2**53),
    ("converted", 1), ("duration", "1"), ("duration", True), ("duration", -1),
    ("duration", 604801), ("room", "a@b.com"), ("room", "a" * 129),
    ("random", 1), ("proxy_id", "secret-proxy"), ("message", "private-text"),
])
def test_chat_validation(client, site, field, value):
    result = client.post("/api/agent/chats", headers=site[1], json=chat(**{field: value}))
    assert result.status_code == 422
    assert "private-text" not in result.text and "secret-proxy" not in result.text


@pytest.mark.parametrize("field,value", [
    ("event_id", "bad"), ("key_id", "sk_private-secret"), ("key_id", "bbk_private-secret"),
    ("key_id", "sk-synthetic-private-secret"), ("key_id", "sk-proj-synthetic-private-secret"),
    ("key_id", "Bearer.secret"), ("key_id", "a" * 81), ("key_id", "a@b.com"),
    ("calls", True), ("calls", -1), ("calls", 2**53), ("error_429", 3),
    ("error_502", 2), ("latency_ms", "100"), ("latency_ms", -1),
    ("prompt", "private-text"),
])
def test_usage_validation(client, site, field, value):
    result = client.post("/api/agent/ai-usage", headers=site[1], json=usage(**{field: value}))
    assert result.status_code == 422
    assert "private-secret" not in result.text and "private-text" not in result.text


@pytest.mark.parametrize("endpoint,payload", [("chats", chat), ("ai-usage", usage)])
def test_auth_required_fields_and_nonfinite(client, admin, site, endpoint, payload):
    url = f"/api/agent/{endpoint}"
    assert client.post(url, json=payload()).status_code == 401
    assert client.post(url, headers=admin, json=payload()).status_code == 401
    body = payload()
    del body["event_id"]
    assert client.post(url, headers=site[1], json=body).status_code == 422
    field = "duration" if endpoint == "chats" else "latency_ms"
    import json
    for value in (float("nan"), float("inf"), -float("inf")):
        result = client.post(url, headers={**site[1], "Content-Type": "application/json"}, content=json.dumps(payload(**{field: value})))
        assert result.status_code == 422


def test_receipts_pagination_and_no_side_effects(client, admin, site, app):
    sid, agent = site
    other, other_agent = make_site(client, admin)
    body = chat(room="session_opaque", random=False)
    first = client.post("/api/agent/chats", headers=agent, json=body).json()
    assert first["duplicate"] is False and first["timestamp"].endswith("Z")
    assert client.post("/api/agent/chats", headers=agent, json=body).json() == {**first, "duplicate": True}
    assert client.post("/api/agent/chats", headers=agent, json={**body, "links": 2}).status_code == 409
    assert client.post("/api/agent/chats", headers=other_agent, json=body).json()["duplicate"] is False
    assert client.post("/api/agent/ai-usage", headers=agent, json=usage(event_id=body["event_id"])).status_code == 409
    second = chat()
    client.post("/api/agent/chats", headers=agent, json=second)
    url = f"/api/sites/{sid}/chats"
    assert client.get(url, headers=agent).status_code == 401
    assert client.get(url).status_code == 401
    result = client.get(url + "?limit=1", headers=admin).json()
    assert result[0]["event_id"] == second["event_id"]
    assert client.get(url + "?offset=1", headers=admin).json()[0]["event_id"] == body["event_id"]
    assert len(client.get(f"/api/sites/{other}/chats", headers=admin).json()) == 1
    for query in ("limit=0", "limit=1001", "offset=-1", "offset=100001"):
        assert client.get(url + "?" + query, headers=admin).status_code == 422
    stats = client.get(f"/api/sites/{sid}/statistics", headers=admin).json()
    assert stats["updated_at"] is None
    assert client.get(f"/api/sites/{sid}/workers", headers=admin).json() == []
    assert client.get(f"/api/sites/{sid}", headers=admin).json()["last_seen"] is None
    assert client.get(f"/api/sites/{uuid4()}/chats", headers=admin).status_code == 404


def test_proxy_ownership_history_recovery_and_secrets(client, admin, site):
    sid, agent = site
    other, other_agent = make_site(client, admin)
    proxy = client.post(f"/api/sites/{sid}/proxies", headers=admin,
                        json={"url": "http://example.com:8080", "username": "private-user", "password": "private-pass"}).json()["id"]
    error = {"level": "error", "message": "connection failed", "proxy_id": proxy}
    assert client.post("/api/agent/chats", headers=other_agent, json=chat(proxy_id=proxy)).status_code == 422
    assert client.post("/api/agent/errors", headers=other_agent, json=error).status_code == 422
    assert client.post("/api/agent/errors", headers=agent, json={**error, "proxy_id": str(uuid4())}).status_code == 422
    client.post("/api/agent/errors", headers=agent, json=error)
    url = f"/api/sites/{sid}/proxy-health"
    assert client.get(url, headers=agent).status_code == 401
    assert client.get(url, headers=admin).json()["proxies"][0]["blocked_status"] == "unknown"
    client.post("/api/agent/errors", headers=agent, json={**error, "code": "proxy_blocked"})
    assert client.get(url, headers=admin).json()["proxies"][0]["blocked_reported"] is True
    client.post("/api/agent/errors", headers=agent, json=error)
    assert client.get(url, headers=admin).json()["proxies"][0]["blocked_reported"] is True
    assert client.delete(f"/api/sites/{sid}/proxies/{proxy}", headers=admin).status_code == 204
    assert client.post("/api/agent/chats", headers=agent, json=chat(proxy_id=proxy)).status_code == 200
    assert client.post("/api/agent/chats", headers=other_agent, json=chat(proxy_id=proxy)).status_code == 422
    assert client.post("/api/agent/errors", headers=agent, json={**error, "code": "proxy_recovered", "level": "info"}).status_code == 201
    result = client.get(url, headers=admin)
    g = result.json()["proxies"][0]
    assert (g["current"], g["chats"], g["links"], g["converted"], g["errors"]) == (False, 1, 1, 1, 4)
    assert g["blocked_status"] == "recovered" and g["blocked_reported"] is False
    assert "private-" not in result.text and "example.com" not in result.text
    assert client.get(f"/api/sites/{other}/proxy-health", headers=admin).json()["proxies"] == []
    for message in ("http://user:private-pass@example.com:80", "Proxy-Authorization: Basic secret", "Bearer secret"):
        response = client.post("/api/agent/errors", headers=agent, json={**error, "message": message})
        assert response.status_code == 422 and "secret" not in response.text and "private-pass" not in response.text


def test_weighted_usage_and_zero_calls(client, admin, site):
    sid, agent = site
    for body in (usage(), usage(calls=6, latency_ms=300), usage(key_id="unused", calls=0, error_429=0, latency_ms=0)):
        assert client.post("/api/agent/ai-usage", headers=agent, json=body).status_code == 200
        assert client.post("/api/agent/ai-usage", headers=agent, json=body).json()["duplicate"] is True
    assert client.post("/api/agent/ai-usage", headers=agent, json=usage(calls=0, error_429=0)).status_code == 422
    url = f"/api/sites/{sid}/ai-usage"
    assert client.get(url, headers=agent).status_code == 401
    groups = client.get(url, headers=admin).json()["keys"]
    assert groups[0] == {"key_id": "primary-slot", "events": 2, "calls": 8, "error_429": 2, "error_502": 0, "latency_ms": 250}
    assert groups[1]["latency_ms"] is None


def test_prune_receipt_capacity_expiry_and_concurrency(client, admin, site, app, monkeypatch):
    sid, agent = site
    monkeypatch.setattr(app.state.telemetry_settings, "history_site", 1)
    monkeypatch.setattr(app.state.telemetry_settings, "receipts_site", 2)
    body = chat()
    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(lambda _: client.post("/api/agent/chats", headers=agent, json=body).json(), range(4)))
    assert sum(not r["duplicate"] for r in results) == 1
    assert client.post("/api/agent/ai-usage", headers=agent, json=usage()).status_code == 200
    assert client.get(f"/api/sites/{sid}/chats", headers=admin).json() == []
    assert client.post("/api/agent/chats", headers=agent, json=body).json()["duplicate"] is True
    assert client.post("/api/agent/chats", headers=agent, json=chat()).status_code == 429
    with app.state.store.transaction() as db:
        db.execute("UPDATE telemetry SET expires_at='2000-01-01T00:00:00Z'")
    assert client.post("/api/agent/chats", headers=agent, json=body).json()["duplicate"] is False


def test_restart_migrations_and_cascade(client, admin, site, app):
    sid, agent = site
    body = chat()
    first = client.post("/api/agent/chats", headers=agent, json=body).json()
    path = app.state.store.path.parent
    Storage(path)
    Storage(path)
    with TestClient(create_app(data_dir=path, admin_password="test-password")) as restarted:
        assert restarted.post("/api/agent/chats", headers=agent, json=body).json() == {**first, "duplicate": True}
        assert restarted.get(f"/api/sites/{sid}/chats", headers=admin).json()[0]["timestamp"] == first["timestamp"]
    client.delete(f"/api/sites/{sid}", headers=admin)
    with app.state.store.transaction() as db:
        for table in ("telemetry", "deleted_proxy_refs"):
            assert db.execute(f"SELECT count(*) FROM {table}").fetchone()[0] == 0


def test_global_caps_and_historical_reference_expiry(client, admin, site, app, monkeypatch):
    sid, agent = site
    other, other_agent = make_site(client, admin)
    monkeypatch.setattr(app.state.telemetry_settings, "history_global", 1)
    monkeypatch.setattr(app.state.telemetry_settings, "receipts_global", 2)
    first = chat()
    client.post("/api/agent/chats", headers=agent, json=first)
    client.post("/api/agent/chats", headers=other_agent, json=chat())
    assert client.get(f"/api/sites/{sid}/chats", headers=admin).json() == []
    assert len(client.get(f"/api/sites/{other}/chats", headers=admin).json()) == 1
    assert client.post("/api/agent/chats", headers=agent, json=first).json()["duplicate"] is True
    assert client.post("/api/agent/chats", headers=other_agent, json=chat()).status_code == 429
    proxy = client.post(f"/api/sites/{sid}/proxies", headers=admin, json={"url": "http://example.com:80"}).json()["id"]
    client.delete(f"/api/sites/{sid}/proxies/{proxy}", headers=admin)
    with app.state.store.transaction() as db:
        db.execute("UPDATE deleted_proxy_refs SET expires_at='2000-01-01T00:00:00Z'")
    assert client.post("/api/agent/errors", headers=agent, json={"proxy_id": proxy, "level": "info", "message": "late"}).status_code == 422


def test_legacy_errors_migration_preserves_rows(tmp_path):
    import sqlite3

    directory = tmp_path / "legacy"
    Storage(directory)
    with sqlite3.connect(directory / "hub.sqlite3") as db:
        db.execute("INSERT INTO sites(id,name,url,description,created_at,token_hash) VALUES('site','name','https://example.com','','old','hash')")
        db.execute("DROP TABLE errors")
        db.execute("CREATE TABLE errors(id TEXT PRIMARY KEY,site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,worker_id TEXT,level TEXT NOT NULL,message TEXT NOT NULL,timestamp TEXT NOT NULL)")
        db.execute("INSERT INTO errors VALUES('error','site',NULL,'error','legacy message','old')")
    for _ in range(2):
        migrated = Storage(directory)
        with migrated.transaction() as db:
            row = db.execute("SELECT * FROM errors").fetchone()
            assert row["message"] == "legacy message"
            assert row["proxy_id"] is None and row["code"] is None


def test_dedup_across_independent_storage_instances(client, site, app):
    _, agent = site
    body = chat()
    with TestClient(create_app(data_dir=app.state.store.path.parent, admin_password="test-password")) as second:
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda c: c.post("/api/agent/chats", headers=agent, json=body), (client, second)))
    assert [r.status_code for r in results] == [200, 200]
    assert sum(not r.json()["duplicate"] for r in results) == 1


def test_extreme_finite_latency_does_not_overflow(client, admin, site):
    import sys

    sid, agent = site
    for calls in (1, 9007199254740991, 123):
        assert client.post("/api/agent/ai-usage", headers=agent, json=usage(calls=calls, latency_ms=sys.float_info.max)).status_code == 200
    result = client.get(f"/api/sites/{sid}/ai-usage", headers=admin)
    assert result.status_code == 200
    assert result.json()["keys"][0]["latency_ms"] == sys.float_info.max


def test_large_valid_aggregates_exceed_int64_without_sql_sum(client, admin, site, app):
    import hashlib
    import json
    import sys
    from hub.app import now

    sid, agent = site
    proxy = client.post(f"/api/sites/{sid}/proxies", headers=admin, json={"url": "http://example.com:80"}).json()["id"]
    large_chat = chat(proxy_id=proxy, links=telemetry.SAFE_INT, converted=True)
    large_usage = usage(calls=telemetry.SAFE_INT, error_429=telemetry.SAFE_INT, latency_ms=sys.float_info.max)
    for _ in range(2):
        assert client.post("/api/agent/chats", headers=agent, json={**large_chat, "event_id": str(uuid4())}).status_code == 200
        assert client.post("/api/agent/ai-usage", headers=agent, json={**large_usage, "event_id": str(uuid4())}).status_code == 200
    # Seed more individually validated records efficiently to exceed int64,
    # not merely JavaScript safe integers. Exercise the actual GET aggregation.
    with app.state.store.transaction() as db:
        for _ in range(1098):
            for kind, model, body in (("chat", telemetry.Chat, large_chat), ("ai", telemetry.AIUsage, large_usage)):
                payload = model.model_validate({**body, "event_id": str(uuid4())}).model_dump(mode="json")
                encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"))
                digest = hashlib.sha256((kind + encoded).encode()).hexdigest()
                timestamp = now()
                db.execute("INSERT INTO telemetry(site_id,event_id,kind,digest,timestamp,payload,expires_at) VALUES(?,?,?,?,?,?,?)", (sid, payload["event_id"], kind, digest, timestamp, encoded, telemetry.expires(timestamp, 7)))
    expected = 1100 * telemetry.SAFE_INT
    assert expected > 2**63 - 1
    health = client.get(f"/api/sites/{sid}/proxy-health", headers=admin)
    assert health.status_code == 200 and health.json()["proxies"][0]["links"] == expected
    usage_result = client.get(f"/api/sites/{sid}/ai-usage", headers=admin)
    assert usage_result.status_code == 200
    key = usage_result.json()["keys"][0]
    assert key["calls"] == key["error_429"] == expected
    assert key["latency_ms"] == sys.float_info.max
    assert client.post("/api/agent/chats", headers=agent, json=chat(links=0, converted=True)).status_code == 200


@pytest.mark.parametrize("synthetic", ["sk_synthetic_not_a_real_key", "sk-synthetic-not-a-real-key", "sk-proj-synthetic-not-a-real-key", "SK-PROJ-SYNTHETIC-NOT-A-REAL-KEY"])
def test_error_credentials_rejected_without_storage(client, admin, site, synthetic):
    sid, agent = site
    result = client.post("/api/agent/errors", headers=agent,
                         json={"level": "error", "message": f"Provider failed with {synthetic}"})
    assert result.status_code == 422
    assert synthetic not in result.text
    errors = client.get(f"/api/sites/{sid}/errors", headers=admin)
    assert errors.status_code == 200 and errors.json() == []


@pytest.mark.parametrize("suffix", ["HISTORY_SITE", "HISTORY_GLOBAL", "RECEIPTS_SITE", "RECEIPTS_GLOBAL", "RETENTION_DAYS"])
@pytest.mark.parametrize("value", ["0", "-1", "1.5", "", "true", "9223372036854775808"])
def test_telemetry_environment_validation(monkeypatch, suffix, value):
    name = "HUB_TELEMETRY_" + suffix
    monkeypatch.setenv(name, value)
    with pytest.raises(RuntimeError, match=name):
        telemetry.Settings.from_env()


def test_telemetry_config_fails_at_startup(tmp_path, monkeypatch):
    monkeypatch.setenv("HUB_TELEMETRY_RETENTION_DAYS", "36501")
    with pytest.raises(RuntimeError, match="HUB_TELEMETRY_RETENTION_DAYS"):
        create_app(data_dir=tmp_path, admin_password="test-password")


def test_environment_caps_and_window_survive_reconfiguration(client, admin, site, app, monkeypatch):
    from datetime import datetime, timedelta

    sid, agent = site
    values = {"HISTORY_SITE": 1, "HISTORY_GLOBAL": 2, "RECEIPTS_SITE": 2,
              "RECEIPTS_GLOBAL": 3, "RETENTION_DAYS": 14}
    for suffix, value in values.items():
        monkeypatch.setenv("HUB_TELEMETRY_" + suffix, str(value))
    directory = app.state.store.path.parent
    configured = create_app(data_dir=directory, admin_password="test-password")
    assert configured.state.telemetry_settings == telemetry.Settings(1, 2, 2, 3, 14)
    body = chat()
    with TestClient(configured) as instance:
        first = instance.post("/api/agent/chats", headers=agent, json=body).json()
        assert first["duplicate"] is False
        assert instance.post("/api/agent/chats", headers=agent, json=chat()).status_code == 200
        assert instance.get(f"/api/sites/{sid}/chats", headers=admin).json()[0]["event_id"] != body["event_id"]
        assert instance.post("/api/agent/chats", headers=agent, json=chat()).status_code == 429
    with app.state.store.transaction() as db:
        row = db.execute("SELECT * FROM telemetry WHERE site_id=? AND event_id=?", (sid, body["event_id"])).fetchone()
        assert datetime.fromisoformat(row["expires_at"]) - datetime.fromisoformat(row["timestamp"]) == timedelta(days=14)
    monkeypatch.setenv("HUB_TELEMETRY_RETENTION_DAYS", "1")
    with TestClient(create_app(data_dir=directory, admin_password="test-password")) as smaller_window:
        result = smaller_window.post("/api/agent/chats", headers=agent, json=body)
        assert result.json() == {**first, "duplicate": True}
    with app.state.store.transaction() as db:
        assert db.execute("SELECT expires_at FROM telemetry WHERE site_id=? AND event_id=?", (sid, body["event_id"])).fetchone()[0] == row["expires_at"]


def test_existing_receipts_migrate_with_original_seven_day_window(client, site, app, monkeypatch):
    from datetime import datetime, timedelta

    sid, agent = site
    body = chat()
    first = client.post("/api/agent/chats", headers=agent, json=body).json()
    with app.state.store.transaction() as db:
        db.execute("DROP INDEX telemetry_expiry")
        db.execute("ALTER TABLE telemetry DROP COLUMN expires_at")
        db.execute("DROP INDEX deleted_proxy_refs_expiry")
        db.execute("ALTER TABLE deleted_proxy_refs DROP COLUMN expires_at")
    monkeypatch.setenv("HUB_TELEMETRY_RETENTION_DAYS", "1")
    directory = app.state.store.path.parent
    for _ in range(2):
        migrated = create_app(data_dir=directory, admin_password="test-password")
        with TestClient(migrated) as instance:
            assert instance.post("/api/agent/chats", headers=agent, json=body).json() == {**first, "duplicate": True}
        with migrated.state.store.transaction() as db:
            row = db.execute("SELECT timestamp,expires_at FROM telemetry WHERE site_id=?", (sid,)).fetchone()
            delta = datetime.fromisoformat(row["expires_at"]) - datetime.fromisoformat(row["timestamp"])
            assert delta == timedelta(days=7)
