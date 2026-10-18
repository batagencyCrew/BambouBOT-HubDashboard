from fastapi.testclient import TestClient

from hub.app import create_app


def test_password_rotation_invalidates_existing_sessions(tmp_path):
    with TestClient(create_app(data_dir=tmp_path, admin_password="old-password")) as client:
        token = client.post("/api/auth/login", json={"password": "old-password"}).json()["access_token"]
    with TestClient(create_app(data_dir=tmp_path, admin_password="new-password")) as client:
        assert client.get("/api/sites", headers={"Authorization": "Bearer " + token}).status_code == 401
        assert client.post("/api/auth/login", json={"password": "new-password"}).status_code == 200
