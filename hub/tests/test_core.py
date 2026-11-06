from fastapi.testclient import TestClient

from .conftest import agent_headers, login, make_user


def test_health_and_auth_required(client):
    assert client.get("/api/health").json()["status"] == "ok"
    assert client.get("/api/sites").status_code == 401


def test_login_logout_and_session_revocation(owner):
    me = owner.get("/api/auth/me").json()["user"]
    assert me["username"] == "owner" and "users:manage" in me["permissions"]
    assert owner.post("/api/auth/logout").status_code == 200
    assert owner.get("/api/auth/me").status_code == 401


def test_wrong_password(client):
    make_user(client)
    assert client.post("/api/auth/login", json={"username": "owner", "password": "nope"}).status_code == 401


def test_site_lifecycle_and_audit(owner, site):
    sites = owner.get("/api/sites").json()
    assert sites[0]["slug"] == "alpha" and sites[0]["health"] == "offline"
    command = owner.post(f"/api/sites/{site['slug']}/commands", json={"action": "start"}).json()
    assert command["status"] == "pending" and not command["agent_online"]
    assert owner.get(f"/api/sites/{site['id']}").json()["desired_state"] == "running"
    # A second lifecycle command supersedes the first.
    owner.post(f"/api/sites/{site['slug']}/commands", json={"action": "pause"})
    history = owner.get(f"/api/sites/{site['slug']}/commands").json()
    assert [c["status"] for c in history] == ["pending", "superseded"]
    actions = [row["action"] for row in owner.get("/api/audit").json()["items"]]
    assert "command.pause" in actions and "site.create" in actions


def test_set_workers_validation(owner, site):
    assert owner.post(f"/api/sites/{site['slug']}/commands", json={"action": "set_workers", "args": {"count": "3"}}).status_code == 400
    ok = owner.post(f"/api/sites/{site['slug']}/commands", json={"action": "set_workers", "args": {"count": 3}})
    assert ok.status_code == 201
    assert owner.post(f"/api/sites/{site['slug']}/commands", json={"action": "rm -rf"}).status_code == 400
    assert owner.post(f"/api/sites/{site['slug']}/commands", json={"action": "custom:refresh_cookies"}).status_code == 201


def test_permissions_and_site_scope(client, owner, site):
    other = owner.post("/api/sites", json={"name": "beta"}).json()["site"]
    created = owner.post("/api/users", json={"username": "viewer1", "password": "viewer password!", "role": "viewer",
                                             "site_scope": [site["id"]]})
    assert created.status_code == 201, created.text
    viewer = TestClient(client.app)
    login(viewer, "viewer1", "viewer password!")
    assert [s["slug"] for s in viewer.get("/api/sites").json()] == ["alpha"]
    assert viewer.get(f"/api/sites/{other['id']}").status_code == 404
    assert viewer.post(f"/api/sites/{site['slug']}/commands", json={"action": "stop"}).status_code == 403
    assert viewer.get("/api/users").status_code == 403


def test_operator_can_control_but_not_reveal(client, owner, site):
    owner.post("/api/users", json={"username": "op", "password": "operator password", "role": "operator"})
    op = TestClient(client.app)
    login(op, "op", "operator password")
    assert op.post(f"/api/sites/{site['slug']}/commands", json={"action": "restart"}).status_code == 201
    assert op.delete(f"/api/sites/{site['slug']}?confirm={site['slug']}").status_code == 403


def test_agent_batch_ingest_and_stats(owner, site):
    headers = agent_headers(site)
    worker = "6f0e7a3c-8a2b-4b7f-9d41-0e3c7a4f1b2d"
    body = {
        "presence": {"agent_version": "2.0.0", "host": {"cpu": 12}, "workers": [
            {"id": worker, "name": "worker-1", "status": "running", "cpu_percent": 5, "memory_mb": 40, "tasks_completed": 7}],
            "capabilities": {"commands": [{"name": "refresh_cookies", "description": "Re-login"}], "sdk": "python/2.0"}},
        "logs": [{"level": "error", "message": "Login failed", "worker_id": worker},
                 {"level": "info", "message": "Started", "worker_name": "worker-1"}],
        "metrics": [{"name": "links_sent", "kind": "count", "value": 3}],
        "costs": [{"event_id": "cost-000001", "provider": "capsolver", "category": "captcha", "amount": 0.0012},
                  {"event_id": "cost-000001", "provider": "capsolver", "category": "captcha", "amount": 0.0012}],
        "balances": [{"provider": "capsolver", "balance": 1.5, "low_threshold": 2}],
        "proxies": [{"key": "abc123", "label": "proxy-1", "state": "blocked", "detail": "403"}],
    }
    response = owner.post("/api/agent/v2/batch", json=body, headers=headers)
    assert response.status_code == 200, response.text
    assert response.json()["accepted"]["costs"] == 1  # duplicate receipt ignored
    site_view = owner.get(f"/api/sites/{site['slug']}").json()
    assert site_view["health"] == "healthy" and site_view["workers"]["running"] == 1
    assert site_view["capabilities"]["commands"][0]["name"] == "refresh_cookies"
    logs = owner.get("/api/logs", params={"site": site["slug"], "level": "error"}).json()["items"]
    assert [l["message"] for l in logs] == ["Login failed"]
    stats = owner.get(f"/api/sites/{site['slug']}/stats").json()
    assert stats["logs"]["errors"] == 1 and stats["metrics"][0]["value"] == 3
    costs = owner.get("/api/costs", params={"group_by": "provider"}).json()
    assert costs["totals"]["USD"] == 0.0012
    assert owner.get("/api/balances").json()[0]["low"] is True
    assert owner.get(f"/api/sites/{site['slug']}/proxy-health").json()[0]["health"] == "failing"
    assert owner.post("/api/agent/v2/batch", json={}, headers={"Authorization": "Bearer nope"}).status_code == 401


def test_issue_opens_alert_and_ack(owner, site):
    owner.post("/api/agent/v2/batch", headers=agent_headers(site),
               json={"issues": [{"title": "Worker stuck on captcha", "severity": "critical", "key": "stuck:1"}]})
    alerts = owner.get("/api/alerts").json()
    assert alerts[0]["title"] == "Worker stuck on captcha"
    # Same key does not create a duplicate.
    owner.post("/api/agent/v2/batch", headers=agent_headers(site), json={"issues": [{"title": "Worker stuck on captcha", "key": "stuck:1"}]})
    assert len(owner.get("/api/alerts").json()) == 1
    assert owner.post(f"/api/alerts/{alerts[0]['id']}/ack").status_code == 200
    assert owner.get("/api/alerts").json()[0]["status"] == "acknowledged"


def test_commands_ack_over_http(owner, site):
    command = owner.post(f"/api/sites/{site['slug']}/commands", json={"action": "start"}).json()
    pending = owner.get("/api/agent/v2/commands", headers=agent_headers(site)).json()
    assert pending[0]["command_id"] == command["id"]
    owner.post(f"/api/agent/v2/commands/{command['id']}/ack", headers=agent_headers(site),
               json={"status": "completed", "message": "Started 3 workers"})
    assert owner.get(f"/api/sites/{site['slug']}/commands").json()[0]["status"] == "completed"


def test_websocket_command_push(owner, site):
    with owner.websocket_connect(f"/ws/site?token={site['token']}") as ws:
        command = owner.post(f"/api/sites/{site['slug']}/commands", json={"action": "stop"}).json()
        assert command["agent_online"] is True
        message = ws.receive_json()
        assert message["type"] == "command" and message["action"] == "stop"
        ws.send_json({"type": "ack", "command_id": message["command_id"], "status": "completed"})
        ws.send_json({"type": "ping"})
        assert ws.receive_json()["type"] == "pong"
    assert owner.get(f"/api/sites/{site['slug']}/commands").json()[0]["status"] == "completed"


def test_websocket_rejects_bad_token(client):
    import pytest
    from starlette.websockets import WebSocketDisconnect
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect("/ws/site?token=bad") as ws:
            ws.receive_json()
