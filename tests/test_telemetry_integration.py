"""Authenticated telemetry across real HTTP, restart, and bounded persistence."""
from contextlib import contextmanager
import json
import os
from pathlib import Path
import socket
import sqlite3
import subprocess
import sys
import time
from uuid import uuid4

from fastapi.testclient import TestClient
import pytest
import requests

from backend.hub.app import create_app


ROOT = Path(__file__).resolve().parents[1]
PASSWORD = "telemetry-integration-only-password"


def chat(**changes):
    return dict(event_id=str(uuid4()), worker_id=str(uuid4()), msgs_in=4,
                msgs_out=3, links=1, converted=True, duration=12.5, **changes)


def usage(event_id=None, calls=2, latency_ms=100):
    return dict(event_id=event_id or str(uuid4()), key_id="primary-slot", calls=calls,
                error_429=0, error_502=0, latency_ms=latency_ms)


@contextmanager
def live_hub(directory):
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    origin = f"http://127.0.0.1:{port}"
    env = {key: value for key, value in os.environ.items() if not key.startswith("HUB_")}
    env.update(HUB_DATA_DIR=str(directory), HUB_ADMIN_PASSWORD=PASSWORD,
               HUB_BACKUP_WORKER_ENABLED="false")
    with (directory.parent / "telemetry-service.log").open("w") as log:
        process = subprocess.Popen([sys.executable, "-m", "uvicorn", "backend.app:app",
                                    "--host", "127.0.0.1", "--port", str(port)],
                                   cwd=ROOT, env=env, stdout=log, stderr=log)
        try:
            deadline = time.monotonic() + 20
            while True:
                try:
                    if requests.get(origin + "/api/health", timeout=1).ok:
                        break
                except requests.RequestException:
                    pass
                if process.poll() is not None or time.monotonic() >= deadline:
                    pytest.fail("Isolated telemetry hub did not start (private fixture log retained)")
                time.sleep(0.1)
            with requests.Session() as session:
                def api(method, path, headers=None, **kwargs):
                    return session.request(method, origin + "/api" + path, headers=headers,
                                           timeout=5, **kwargs)
                yield api
        finally:
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()


def admin_headers(api):
    response = api("POST", "/auth/login", json={"password": PASSWORD})
    assert response.status_code == 200
    return {"Authorization": "Bearer " + response.json()["access_token"]}


def enroll(api, admin, name):
    response = api("POST", "/sites", headers=admin,
                   json={"name": name, "url": "https://example.com"})
    assert response.status_code == 201
    data = response.json()
    return data["site"]["id"], {"Authorization": "Bearer " + data["agent_token"]}


def test_real_http_site_isolation_retries_proxy_history_and_restart(tmp_path):
    directory = tmp_path / "hub"
    with live_hub(directory) as api:
        admin = admin_headers(api)
        sites = [enroll(api, admin, name) for name in ("Alpha", "Beta")]
        event_id = str(uuid4())
        receipts = []
        for index, (sid, agent) in enumerate(sites):
            base = f"/sites/{sid}"
            proxy = api("POST", base + "/proxies", headers=admin, json={
                "url": "socks5://proxy.example.com:1080", "username": "fixture-user",
                "password": "fixture-proxy-secret",
            }).json()["id"]
            body = chat(proxy_id=proxy, room="opaque_room", random=False)
            body["event_id"] = event_id
            receipt = api("POST", "/agent/chats", headers=agent, json=body)
            assert receipt.status_code == 200 and receipt.json()["duplicate"] is False
            repeated = api("POST", "/agent/chats", headers=agent, json=body).json()
            assert repeated == {**receipt.json(), "duplicate": True}
            receipts.append((body, receipt.json()))
            assert api("POST", "/agent/chats", headers=agent,
                       json={**body, "links": 2}).status_code == 409
            assert api("POST", "/agent/ai-usage", headers=agent,
                       json=usage(event_id)).status_code == 409
            assert api("POST", "/agent/chats", headers=admin, json=chat()).status_code in (401, 403)
            assert api("POST", "/agent/chats", json=chat()).status_code in (401, 403)
            for endpoint in ("chats", "ai-usage", "proxy-health"):
                assert api("GET", base + "/" + endpoint, headers=agent).status_code in (401, 403)
            first = usage(calls=2, latency_ms=100)
            second = usage(calls=6, latency_ms=300)
            second.update(error_429=1, error_502=2)
            for batch in (first, second):
                accepted = api("POST", "/agent/ai-usage", headers=agent, json=batch)
                assert accepted.status_code == 200
                assert api("POST", "/agent/ai-usage", headers=agent, json=batch).json() == {
                    **accepted.json(), "duplicate": True,
                }
            aggregate = api("GET", base + "/ai-usage", headers=admin).json()
            assert aggregate == {"site_id": sid, "keys": [{"key_id": "primary-slot", "events": 2,
                "calls": 8, "error_429": 1, "error_502": 2, "latency_ms": 250.0}]}
            rows = api("GET", base + "/chats?limit=1&offset=0", headers=admin).json()
            assert rows == [{**body, "site_id": sid, "timestamp": receipt.json()["timestamp"]}]
            assert api("GET", base + "/chats?limit=1&offset=1", headers=admin).json() == []
            for code in ("proxy_timeout", "proxy_blocked", "proxy_recovered"):
                error = api("POST", "/agent/errors", headers=agent, json={
                    "worker_id": body["worker_id"], "proxy_id": proxy, "level": "warning",
                    "code": code, "message": "Sanitized fixture result",
                })
                assert error.status_code == 201
                health = api("GET", base + "/proxy-health", headers=admin).json()["proxies"][0]
                assert health["blocked_status"] == {
                    "proxy_timeout": "unknown", "proxy_blocked": "blocked", "proxy_recovered": "recovered",
                }[code]
            assert health["chats"] == health["links"] == health["converted"] == 1
            assert health["errors"] == 3 and health["blocked_reported"] is False
            assert api("DELETE", base + "/proxies/" + proxy, headers=admin).status_code == 204
            late = chat(proxy_id=proxy)
            assert api("POST", "/agent/chats", headers=agent, json=late).status_code == 200
            other_agent = sites[1 - index][1]
            assert api("POST", "/agent/chats", headers=other_agent, json=chat(proxy_id=proxy)).status_code == 422
            health = api("GET", base + "/proxy-health", headers=admin).json()["proxies"][0]
            assert health["current"] is False and health["chats"] == 2
            assert "fixture-proxy-secret" not in json.dumps(health)
            assert api("GET", base + "/statistics", headers=admin).json()["updated_at"] is None
            rejected = api("POST", "/agent/chats", headers=agent,
                           json={**chat(), "contents": "fixture-chat-content-never-persist"})
            assert rejected.status_code == 422
            rejected = api("POST", "/agent/ai-usage", headers=agent,
                           json={**usage(), "key_id": "sk-fixture-secret-never-persist"})
            assert rejected.status_code == 422
            assert "sk-fixture-secret-never-persist" not in rejected.text
    with live_hub(directory) as api:
        admin = admin_headers(api)
        for (sid, agent), (body, receipt) in zip(sites, receipts):
            assert api("POST", "/agent/chats", headers=agent, json=body).json() == {
                **receipt, "duplicate": True,
            }
            assert len(api("GET", f"/sites/{sid}/chats", headers=admin).json()) == 2
    database = directory / "hub.sqlite3"
    with sqlite3.connect(database) as db:
        persisted = "\n".join(db.iterdump())
        assert "fixture-chat-content-never-persist" not in persisted
        assert "sk-fixture-secret-never-persist" not in persisted
        assert "fixture-proxy-secret" not in persisted
        for _, agent in sites:
            assert agent["Authorization"].removeprefix("Bearer ") not in persisted


def test_payload_pruning_retains_receipts_and_capacity_rejects_new_ids(tmp_path, monkeypatch):
    # Exercise the production transaction/pruning path with deliberately small
    # limits, without thousands of HTTP requests or large test databases.
    monkeypatch.setenv("HUB_TELEMETRY_HISTORY_SITE", "2")
    monkeypatch.setenv("HUB_TELEMETRY_HISTORY_GLOBAL", "3")
    monkeypatch.setenv("HUB_TELEMETRY_RECEIPTS_SITE", "4")
    monkeypatch.setenv("HUB_TELEMETRY_RECEIPTS_GLOBAL", "6")
    monkeypatch.setenv("HUB_BACKUP_WORKER_ENABLED", "false")
    with TestClient(create_app(data_dir=tmp_path, admin_password=PASSWORD)) as client:
        def api(method, path, **kwargs):
            return client.request(method, "/api" + path, **kwargs)
        admin = admin_headers(api)
        sid, agent = enroll(api, admin, "bounded")
        events = [chat() for _ in range(4)]
        receipts = [api("POST", "/agent/chats", headers=agent, json=body).json() for body in events]
        rows = api("GET", f"/sites/{sid}/chats", headers=admin).json()
        assert [row["event_id"] for row in rows] == [body["event_id"] for body in reversed(events[-2:])]
        assert api("POST", "/agent/chats", headers=agent, json=events[0]).json() == {
            **receipts[0], "duplicate": True,
        }
        assert len(api("GET", f"/sites/{sid}/chats", headers=admin).json()) == 2
        rejected = api("POST", "/agent/chats", headers=agent, json=chat())
        assert rejected.status_code == 429 and rejected.headers["Retry-After"] == "3600"
        sid2, agent2 = enroll(api, admin, "global-bound")
        for _ in range(2):
            assert api("POST", "/agent/ai-usage", headers=agent2, json=usage()).status_code == 200
        assert len(api("GET", f"/sites/{sid}/chats", headers=admin).json()) == 1
        rejected = api("POST", "/agent/ai-usage", headers=agent2, json=usage())
        assert rejected.status_code == 429
