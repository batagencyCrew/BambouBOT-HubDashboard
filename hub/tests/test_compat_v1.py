"""The v1 agent contract keeps working against v2 storage."""

from .conftest import agent_headers

WORKER = "6f0e7a3c-8a2b-4b7f-9d41-0e3c7a4f1b2d"


def test_v1_heartbeat_commands_errors(owner, site):
    headers = agent_headers(site)
    beat = owner.post("/api/agent/heartbeat", headers=headers, json={"status": "healthy", "workers": [
        {"id": WORKER, "name": "worker-1", "status": "running", "cpu_percent": 3, "memory_mb": 50, "tasks_completed": 2}]})
    assert beat.status_code == 200 and beat.json()["desired_state"] == "stopped"
    command = owner.post(f"/api/sites/{site['slug']}/commands", json={"action": "start"}).json()
    polled = owner.get("/api/agent/commands", headers=headers).json()
    assert polled[0]["id"] == command["id"] and polled[0]["action"] == "start"
    assert owner.post(f"/api/agent/commands/{command['id']}/ack", headers=headers, json={"status": "completed"}).status_code == 200
    assert owner.post("/api/agent/errors", headers=headers, json={"level": "warning", "message": "slow"}).status_code == 201
    logs = owner.get("/api/logs", params={"site": site["slug"]}).json()["items"]
    assert logs[0]["message"] == "slow" and logs[0]["level"] == "warning"


def test_v1_local_sync_and_config(owner, site):
    headers = agent_headers(site)
    synced = owner.post("/api/agent/local-sync", headers=headers, json={
        "expected_revision": 0, "config": {"ai_api_key": "bbk_x", "number_of_workers": 3, "ai_preset_id": "42"},
        "proxies_content": "http://u:p@1.2.3.4:8080\n"}).json()
    assert synced["number_of_workers"] == 3 and synced["ai_api_key"] == "bbk_x"
    assert synced["proxies"][0]["username"] == "u" and synced["proxies"][0]["password"] == "p"
    # Admin edits config.json in v2; v1 agent sees it.
    owner.patch(f"/api/sites/{site['slug']}/files/content", params={"path": "config.json"},
                json={"set": {"number_of_workers": 5}})
    assert owner.get("/api/agent/config", headers=headers).json()["number_of_workers"] == 5


def test_v1_statistics_and_ai_usage_become_metrics(owner, site):
    headers = agent_headers(site)
    owner.post("/api/agent/statistics", headers=headers, json={"links_sent_successfully": 12, "average_messages_per_chat": 3.5})
    owner.post("/api/agent/ai-usage", headers=headers, json={"event_id": "e1", "key_id": "main", "calls": 4,
                                                              "error_429": 1, "error_502": 0, "latency_ms": 900})
    names = {m["name"] for m in owner.get(f"/api/sites/{site['slug']}/metrics").json()}
    assert {"links_sent_successfully", "ai.calls", "ai.error_429"} <= names
