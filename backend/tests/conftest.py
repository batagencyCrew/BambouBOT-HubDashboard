import pytest
from fastapi.testclient import TestClient

from hub.app import create_app


@pytest.fixture(autouse=True)
def isolated_backup_worker(monkeypatch):
    monkeypatch.setenv("HUB_BACKUP_WORKER_ENABLED", "false")


@pytest.fixture
def app(tmp_path, monkeypatch):
    for key in ("HUB_ADMIN_PASSWORD", "HUB_ENCRYPTION_KEY", "HUB_CORS_ORIGINS", "HUB_DATA_DIR"):
        monkeypatch.delenv(key, raising=False)
    return create_app(data_dir=tmp_path / "data", admin_password="test-password")


@pytest.fixture
def client(app):
    with TestClient(app) as client:
        yield client


@pytest.fixture
def admin(client):
    response = client.post("/api/auth/login", json={"password": "test-password"})
    assert response.status_code == 200
    return {"Authorization": f"Bearer {response.json()['access_token']}"}


@pytest.fixture
def site(client, admin):
    response = client.post("/api/sites", json={"name": "Site one", "url": "https://example.com"}, headers=admin)
    assert response.status_code == 201
    value = response.json()
    return value["site"]["id"], {"Authorization": f"Bearer {value['agent_token']}"}
