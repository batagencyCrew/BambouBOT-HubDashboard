import json
from datetime import datetime, timezone
from uuid import uuid4

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from hub.app import Storage, create_app


REPORT = "/api/agent/statistics"
SNAPSHOT = {"links_sent_successfully": 42, "average_messages_per_chat": 2.75}


def read_statistics(client, admin, site_id):
    response = client.get(f"/api/sites/{site_id}/statistics", headers=admin)
    assert response.status_code == 200
    return response.json()


def unknown(site_id):
    return {"site_id": site_id, "links_sent_successfully": None,
            "average_messages_per_chat": None, "updated_at": None}


def test_auth_scope_and_token_rotation(client, admin, site):
    site_id, agent = site
    path = f"/api/sites/{site_id}/statistics"
    for headers in ({}, {"Authorization": "Bearer invalid"}, admin):
        assert client.post(REPORT, headers=headers, json=SNAPSHOT).status_code == 401
    for headers in ({}, {"Authorization": "Bearer invalid"}, agent):
        assert client.get(path, headers=headers).status_code == 401
    assert read_statistics(client, admin, site_id) == unknown(site_id)
    other = client.post("/api/sites", headers=admin,
                        json={"name": "Other", "url": "https://other.example"}).json()
    other_id = other["site"]["id"]
    other_agent = {"Authorization": "Bearer " + other["agent_token"]}
    assert client.post(REPORT, headers=other_agent, json=SNAPSHOT).json()["site_id"] == other_id
    assert read_statistics(client, admin, site_id) == unknown(site_id)
    assert client.get(path, headers=other_agent).status_code == 401
    assert client.post(REPORT, headers=agent, json={**SNAPSHOT, "site_id": other_id}).status_code == 422
    token = client.post(f"/api/sites/{site_id}/agent-token", headers=admin).json()["agent_token"]
    assert client.post(REPORT, headers=agent, json=SNAPSHOT).status_code == 401
    assert client.post(REPORT, headers={"Authorization": "Bearer " + token}, json=SNAPSHOT).status_code == 200
    assert client.get(f"/api/sites/{uuid4()}/statistics", headers=admin).status_code == 404


def test_snapshots_replace_idempotently_and_timestamp_receipt(client, admin, site, app, monkeypatch):
    site_id, agent = site
    assert read_statistics(client, admin, site_id) == unknown(site_id)
    before = datetime.now(timezone.utc)
    response = client.post(REPORT, headers=agent, json=SNAPSHOT)
    assert response.status_code == 200
    first = response.json()
    assert first == {"site_id": site_id, **SNAPSHOT, "updated_at": first["updated_at"]}
    assert first["updated_at"].endswith("Z")
    assert before <= datetime.fromisoformat(first["updated_at"].replace("Z", "+00:00")) <= datetime.now(timezone.utc)
    monkeypatch.setattr("hub.app.now", lambda: "2030-01-02T03:04:05Z")
    repeated = client.post(REPORT, headers=agent, json=SNAPSHOT).json()
    assert repeated == {**first, "updated_at": "2030-01-02T03:04:05Z"}
    assert read_statistics(client, admin, site_id) == repeated
    for payload in ({"links_sent_successfully": 3, "average_messages_per_chat": 1},
                    {"links_sent_successfully": 0, "average_messages_per_chat": 0},
                    {"links_sent_successfully": 0, "average_messages_per_chat": None},
                    {"links_sent_successfully": 9007199254740991, "average_messages_per_chat": 1_000_000_000}):
        result = client.post(REPORT, headers=agent, json=payload)
        assert result.status_code == 200
        assert result.json() == {"site_id": site_id, **payload, "updated_at": "2030-01-02T03:04:05Z"}
        assert read_statistics(client, admin, site_id) == result.json()
    with app.state.store.transaction() as db:
        assert db.execute("SELECT COUNT(*) FROM statistics WHERE site_id=?", (site_id,)).fetchone()[0] == 1
        assert db.execute("SELECT revision,admin_modified FROM configs WHERE site_id=?", (site_id,)).fetchone()[:] == (0, 0)
    assert client.get(f"/api/sites/{site_id}", headers=admin).json()["last_seen"] is None


@pytest.mark.parametrize("payload", [
    {}, {"links_sent_successfully": 0}, {"average_messages_per_chat": None},
    *[{**SNAPSHOT, "links_sent_successfully": value}
      for value in (-1, 9007199254740992, 2**63, True, False, 1.0, "1", None, [], {})],
    *[{**SNAPSHOT, "average_messages_per_chat": value}
      for value in (-0.1, 1_000_000_000.1, True, False, "1", "NaN", [], {})],
    {**SNAPSHOT, "message": "private-chat-content"},
    {**SNAPSHOT, "url": "https://private.example/secret"},
    {**SNAPSHOT, "ai_api_key": "private-key"},
    {**SNAPSHOT, "worker_id": "private-worker"},
    {**SNAPSHOT, "updated_at": "2030-01-01T00:00:00Z"},
])
def test_invalid_schema_is_sanitized_and_does_not_mutate(client, admin, site, payload, caplog):
    site_id, agent = site
    before = client.post(REPORT, headers=agent, json=SNAPSHOT).json()
    response = client.post(REPORT, headers=agent, json=payload)
    assert response.status_code == 422
    for error in response.json()["detail"]:
        assert set(error) == {"loc", "type", "msg"}
        assert error["msg"] == "Invalid input"
    for secret in ("private-chat-content", "https://private.example/secret", "private-key", "private-worker"):
        assert secret not in response.text + caplog.text
    assert read_statistics(client, admin, site_id) == before


@pytest.mark.parametrize("field", ["links_sent_successfully", "average_messages_per_chat"])
@pytest.mark.parametrize("value", [float("nan"), float("inf"), -float("inf")])
def test_nonfinite_json_is_rejected_safely(client, admin, site, field, value):
    site_id, agent = site
    # Send raw JSON: httpx's json encoder itself rejects these nonstandard tokens.
    response = client.post(REPORT, headers={**agent, "Content-Type": "application/json"},
                           content=json.dumps({**SNAPSHOT, field: value}))
    assert response.status_code == 422
    assert all(error["msg"] == "Invalid input" for error in response.json()["detail"])
    assert read_statistics(client, admin, site_id) == unknown(site_id)


@pytest.mark.parametrize("reported", [False, True])
def test_existing_activity_does_not_infer_statistics(client, admin, site, reported):
    site_id, agent = site
    worker = {"id": str(uuid4()), "name": "worker", "status": "running", "tasks_completed": 100}
    expected = client.post(REPORT, headers=agent, json=SNAPSHOT).json() if reported else unknown(site_id)
    for _ in range(2):
        assert client.post("/api/agent/heartbeat", headers=agent,
                           json={"status": "healthy", "workers": [worker]}).status_code == 200
        assert client.post("/api/agent/errors", headers=agent,
                           json={"level": "info", "message": "activity"}).status_code == 201
    assert read_statistics(client, admin, site_id) == expected


def test_migration_persistence_and_site_cascade(client, admin, site, app):
    site_id, agent = site
    directory = app.state.store.path.parent
    # Simulate a pre-statistics database containing an existing site/config.
    with app.state.store.transaction() as db:
        db.execute("DROP TABLE statistics")
    for _ in range(2):
        Storage(directory)
    assert read_statistics(client, admin, site_id) == unknown(site_id)
    snapshot = client.post(REPORT, headers=agent, json=SNAPSHOT).json()
    for _ in range(2):
        restarted = create_app(data_dir=directory, admin_password="test-password")
        with TestClient(restarted) as second:
            assert read_statistics(second, admin, site_id) == snapshot
            assert second.get("/api/agent/config", headers=agent).status_code == 200
    assert client.delete(f"/api/sites/{site_id}", headers=admin).status_code == 204
    with app.state.store.transaction() as db:
        assert db.execute("SELECT COUNT(*) FROM statistics WHERE site_id=?", (site_id,)).fetchone()[0] == 0
        assert db.execute("PRAGMA foreign_key_check").fetchall() == []
    assert client.get(f"/api/sites/{site_id}/statistics", headers=admin).status_code == 404
    assert client.post(REPORT, headers=agent, json=SNAPSHOT).status_code == 401


def test_backup_deletion_guard_keeps_snapshot(client, admin, site, app, monkeypatch):
    site_id, agent = site
    snapshot = client.post(REPORT, headers=agent, json=SNAPSHOT).json()

    def guard(db, guarded_id):
        assert guarded_id == site_id
        raise HTTPException(409, "Site has active backups")

    monkeypatch.setattr(app.state.backups, "guard_site_deletion", guard)
    assert client.delete(f"/api/sites/{site_id}", headers=admin).status_code == 409
    assert read_statistics(client, admin, site_id) == snapshot
