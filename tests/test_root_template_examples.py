"""Shipped starter examples must enroll against the actual hub schema."""
import json
from pathlib import Path

from fastapi.testclient import TestClient
import pytest

from agent.local_files import HubError, LocalFiles
from backend.hub.app import create_app


ROOT = Path(__file__).resolve().parents[1]
MANAGED_KEYS = {"ai_api_key", "number_of_workers", "ai_preset_id"}


@pytest.fixture
def hub(tmp_path, monkeypatch):
    monkeypatch.setenv("HUB_BACKUP_WORKER_ENABLED", "false")
    with TestClient(create_app(data_dir=tmp_path / "hub", admin_password="example-test-password")) as client:
        login = client.post("/api/auth/login", json={"password": "example-test-password"})
        login.raise_for_status()
        yield client, {"Authorization": "Bearer " + login.json()["access_token"]}


@pytest.mark.parametrize("language", ["python", "node", "go"])
def test_actual_examples_enroll_without_uploading_local_extras(language, hub, tmp_path):
    client, admin = hub
    examples = ROOT / "templates" / language
    sample = json.loads((examples / "config.example.json").read_text())
    assert set(sample) == MANAGED_KEYS
    assert sample["number_of_workers"] == 0
    assert sample["ai_api_key"] == ""
    created = client.post("/api/sites", headers=admin, json={
        "name": language + " example", "url": "https://example.com",
    })
    created.raise_for_status()
    token = created.json()["agent_token"]
    site_id = created.json()["site"]["id"]
    headers = {"Authorization": "Bearer " + token}
    local = LocalFiles(tmp_path / language)
    sample["automation_secret"] = "fixture-only"
    (local.directory / "config.json").write_text(json.dumps(sample))
    (local.directory / "proxies.txt").write_bytes((examples / "proxies.example.txt").read_bytes())
    posted = []

    def request(method, path, **kwargs):
        if method == "POST":
            posted.append(kwargs["json"])
        response = client.request(method, "/api/agent" + path, headers=headers, **kwargs)
        if response.status_code >= 400:
            raise HubError(response.status_code)
        return response.json()

    config = local.fetch(request)
    assert set(posted[0]["config"]) == MANAGED_KEYS
    assert "fixture-only" not in json.dumps(posted)
    assert config["number_of_workers"] == 0 and config["ai_api_key"] == ""
    assert config["proxies"] == []
    assert "automation_secret" not in config and "fixture-only" not in json.dumps(config)
    assert json.loads((local.directory / "config.json").read_text())["automation_secret"] == "fixture-only"
    for path in local.directory.iterdir():
        assert token not in path.read_text()
        assert path.stat().st_mode & 0o777 == 0o600
    response = client.get(f"/api/sites/{site_id}/config", headers=admin)
    response.raise_for_status()
    assert response.json()["number_of_workers"] == 0
    assert response.json()["has_ai_api_key"] is False


def test_invalid_local_config_preserves_all_files_before_enrollment(hub, tmp_path):
    client, admin = hub
    created = client.post("/api/sites", headers=admin, json={
        "name": "invalid example", "url": "https://example.com",
    }).json()
    headers = {"Authorization": "Bearer " + created["agent_token"]}
    local = LocalFiles(tmp_path / "invalid")
    original = {"config.json": '{"number_of_workers": "not-an-integer", "automation_secret": "fixture-only"}',
                "proxies.txt": "proxy.example.com:8080\n"}
    for name, content in original.items():
        (local.directory / name).write_text(content)
    methods = []

    def request(method, path, **kwargs):
        methods.append(method)
        response = client.request(method, "/api/agent" + path, headers=headers, **kwargs)
        response.raise_for_status()
        return response.json()

    with pytest.raises(ValueError, match="files preserved"):
        local.fetch(request)
    assert methods == ["GET"]
    assert {path.name: path.read_text() for path in local.directory.iterdir()} == original
