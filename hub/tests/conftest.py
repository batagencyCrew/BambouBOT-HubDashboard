import os
import secrets
import uuid
from pathlib import Path

import psycopg
import pytest
from fastapi.testclient import TestClient


def _env():
    path = Path("/root/.hubv2-dev.env")
    if path.exists():
        for line in path.read_text().splitlines():
            key, _, value = line.partition("=")
            os.environ.setdefault(key, value)
    url = os.environ.get("HUB_TEST_DATABASE_URL")
    if not url:
        pytest.skip("HUB_TEST_DATABASE_URL not set")
    return url


@pytest.fixture
def database_url():
    """A throwaway schema per test, dropped afterwards."""
    base = _env()
    schema = "t_" + uuid.uuid4().hex[:12]
    with psycopg.connect(base, autocommit=True) as conn:
        conn.execute(f"CREATE SCHEMA {schema}")
    sep = "&" if "?" in base else "?"
    yield f"{base}{sep}options=-csearch_path%3D{schema},public"
    with psycopg.connect(base, autocommit=True) as conn:
        conn.execute(f"DROP SCHEMA {schema} CASCADE")


@pytest.fixture
def app(database_url, tmp_path):
    from hub.app import create_app
    from hub.config import Settings
    settings = Settings.from_env(database_url=database_url, data_dir=tmp_path / "data",
                                 secret_key=secrets.token_hex(32).encode(), secure_cookies=False,
                                 background_tasks=False, rclone_binary="rclone",
                                 rclone_config=str(tmp_path / "rclone.conf"))
    return create_app(settings=settings)


@pytest.fixture
def client(app):
    with TestClient(app) as test_client:
        yield test_client


def make_user(client, username="owner", role="owner", password="correct horse battery", **extra):
    from hub.security import hash_password
    db = client.app.state.db
    db.execute("INSERT INTO users(username, password_hash, role, permissions, site_scope) VALUES(%s,%s,%s,%s,%s)",
               (username, hash_password(password), role, extra.get("permissions", []), extra.get("site_scope")))
    return password


def login(client, username="owner", password="correct horse battery"):
    response = client.post("/api/auth/login", json={"username": username, "password": password})
    assert response.status_code == 200, response.text
    return response


@pytest.fixture
def owner(client):
    make_user(client)
    login(client)
    return client


@pytest.fixture
def site(owner):
    response = owner.post("/api/sites", json={"name": "alpha", "url": "https://alpha.example"})
    assert response.status_code == 201, response.text
    body = response.json()
    return {"id": body["site"]["id"], "slug": body["site"]["slug"], "token": body["agent_token"]}


def agent_headers(site):
    return {"Authorization": f"Bearer {site['token']}"}
