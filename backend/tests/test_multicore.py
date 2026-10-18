from uuid import uuid4


def test_multicore_cpu_percent_is_preserved(client, admin, site):
    site_id, agent = site
    response = client.post("/api/agent/heartbeat", headers=agent, json={
        "status": "healthy", "workers": [{
            "id": str(uuid4()), "name": "multicore worker", "status": "running", "cpu_percent": 250.5,
        }],
    })
    assert response.status_code == 200
    workers = client.get(f"/api/sites/{site_id}/workers", headers=admin).json()
    assert workers[0]["cpu_percent"] == 250.5
