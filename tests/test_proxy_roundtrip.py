from agent.local_files import LocalFiles
from backend.hub.app import create_app
from fastapi.testclient import TestClient
import pytest


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("HUB_BACKUP_WORKER_ENABLED", "false")
    with TestClient(create_app(data_dir=tmp_path / "hub", admin_password="test-roundtrip-password")) as value:
        yield value


@pytest.fixture
def admin(client):
    token = client.post("/api/auth/login", json={"password": "test-roundtrip-password"}).json()["access_token"]
    return {"Authorization": "Bearer " + token}


@pytest.fixture
def site(client, admin):
    created = client.post("/api/sites", headers=admin, json={"name": "Source", "url": "https://example.com"}).json()
    return created["site"]["id"], {"Authorization": "Bearer " + created["agent_token"]}


def test_private_proxy_file_roundtrips_encoded_password_to_fresh_hub(client, admin, site, tmp_path):
    site_id, source_token = site
    password = "p:# %@unicode-é"
    added = client.post(f"/api/sites/{site_id}/proxies", headers=admin, json={
        "url": "socks5://proxy.example.com:1080", "username": "user name", "password": password,
    })
    assert added.status_code == 201
    config = client.get("/api/agent/config", headers=source_token).json()
    local = LocalFiles(tmp_path / "runtime")
    local.publish(config)
    encoded = (local.directory / "proxies.txt").read_text()
    assert "%20" in encoded and "%40" in encoded and password not in encoded
    created = client.post("/api/sites", headers=admin, json={"name": "Fresh enrollment", "url": "https://example.com"}).json()
    target_headers = {"Authorization": "Bearer " + created["agent_token"]}
    enrolled = client.post("/api/agent/local-sync", headers=target_headers,
                           json={"expected_revision": 0, "proxies_content": encoded})
    assert enrolled.status_code == 200
    proxies = enrolled.json()["proxies"]
    assert len(proxies) == 1 and proxies[0]["password"] == password and proxies[0]["username"] == "user name"
