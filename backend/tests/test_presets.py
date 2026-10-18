import asyncio
import inspect
import json
import sqlite3
import time
from uuid import uuid4

import httpx
import pytest

import hub.app as api


SAVED_KEY = "synthetic-saved-key"
TRANSIENT_KEY = "synthetic-transient-key"


@pytest.fixture
def upstream(monkeypatch):
    real_client = httpx.AsyncClient
    calls = []

    def install(handler):
        def factory(**kwargs):
            assert kwargs == {"timeout": 10.0, "follow_redirects": False, "verify": True, "trust_env": False}

            async def dispatch(request):
                calls.append(request)
                assert request.method == "GET"
                assert str(request.url) == api.PRESETS_URL
                response = handler(request)
                return await response if inspect.isawaitable(response) else response

            return real_client(transport=httpx.MockTransport(dispatch), **kwargs)

        monkeypatch.setattr(api.httpx, "AsyncClient", factory)
        return calls

    return install


def save_key(client, admin, site_id, key=SAVED_KEY):
    response = client.put(f"/api/sites/{site_id}/config", headers=admin, json={
        "number_of_workers": 3, "ai_preset_id": "unchanged-preset",
        "ai_api_key": key, "captcha_api_key": "synthetic-captcha-key",
    })
    assert response.status_code == 200


def snapshot(app):
    with app.state.store.transaction() as db:
        return "\n".join(db.iterdump())


@pytest.mark.parametrize("transient", [False, True])
def test_saved_and_transient_are_read_only(client, admin, site, app, upstream, transient):
    site_id, agent = site
    save_key(client, admin, site_id)
    before = snapshot(app)
    expected_key = TRANSIENT_KEY if transient else SAVED_KEY

    def handler(request):
        assert request.headers["Authorization"] == f"Bearer {expected_key}"
        # BEGIN IMMEDIATE succeeds only if the endpoint released its transaction.
        with sqlite3.connect(app.state.store.path, timeout=0) as db:
            db.execute("BEGIN IMMEDIATE")
            db.rollback()
        return httpx.Response(200, json={"presets": [
            {"id": "3047", "name": "Example", "language": "French", "archived": False},
            {"id": 42, "name": " Archived ", "archived": True},
            {"id": 1.5, "name": "Default"},
        ], "ignored": SAVED_KEY})

    calls = upstream(handler)
    response = client.post(f"/api/sites/{site_id}/presets", headers=admin,
                           json={"ai_api_key": TRANSIENT_KEY} if transient else {})
    assert response.status_code == 200
    assert response.json() == {"presets": [
        {"id": "3047", "name": "Example", "archived": False},
        {"id": "42", "name": "Archived", "archived": True},
        {"id": "1.5", "name": "Default", "archived": False},
    ]}
    assert len(calls) == 1
    assert SAVED_KEY not in response.text and TRANSIENT_KEY not in response.text
    assert snapshot(app) == before
    assert SAVED_KEY not in before and TRANSIENT_KEY not in before
    assert SAVED_KEY.encode() not in app.state.store.path.read_bytes()
    assert TRANSIENT_KEY.encode() not in app.state.store.path.read_bytes()
    assert client.get("/api/agent/config", headers=agent).json()["ai_api_key"] == SAVED_KEY


def test_transient_without_saved_key(client, admin, site, app, upstream):
    calls = upstream(lambda request: httpx.Response(200, json={"presets": []}))
    before = snapshot(app)
    response = client.post(f"/api/sites/{site[0]}/presets", headers=admin, json={"ai_api_key": TRANSIENT_KEY})
    assert response.json() == {"presets": []}
    assert calls[0].headers["Authorization"] == f"Bearer {TRANSIENT_KEY}"
    assert snapshot(app) == before


def test_auth_scope_and_site_validation(client, admin, site, upstream):
    calls = upstream(lambda request: pytest.fail("Must not contact provider"))
    path = f"/api/sites/{site[0]}/presets"
    for headers in ({}, site[1], {"Authorization": "Bearer invalid"}):
        assert client.post(path, headers=headers, json={"ai_api_key": TRANSIENT_KEY}).status_code == 401
    assert client.post(f"/api/sites/{uuid4()}/presets", headers=admin, json={"ai_api_key": TRANSIENT_KEY}).status_code == 404
    assert client.post("/api/sites/not-a-uuid/presets", headers=admin, json={}).status_code == 422
    assert calls == []


@pytest.mark.parametrize("body,status", [
    ({}, 400), ({"ai_api_key": ""}, 400), ({"ai_api_key": "   "}, 400),
    ({"ai_api_key": "bad\r\nkey"}, 400), ({"ai_api_key": "é"}, 400),
    ({"ai_api_key": None}, 422), ({"ai_api_key": 123}, 422),
    ({"ai_api_key": "x" * 8193}, 422), ({"url": "https://other.example"}, 422),
])
def test_invalid_or_missing_key(client, admin, site, upstream, body, status):
    calls = upstream(lambda request: pytest.fail("Must not contact provider"))
    response = client.post(f"/api/sites/{site[0]}/presets", headers=admin, json=body)
    assert response.status_code == status
    assert calls == []


def test_explicit_empty_does_not_use_saved_key(client, admin, site, upstream):
    save_key(client, admin, site[0])
    calls = upstream(lambda request: pytest.fail("Must not contact provider"))
    response = client.post(f"/api/sites/{site[0]}/presets", headers=admin, json={"ai_api_key": ""})
    assert response.status_code == 400
    assert "key required" in response.json()["detail"]
    assert not calls


@pytest.mark.parametrize("payload", [
    None, [], {}, {"presets": {}}, {"presets": [None]},
    {"presets": [{}]}, {"presets": [{"id": True, "name": "N"}]},
    {"presets": [{"id": None, "name": "N"}]},
    {"presets": [{"id": [], "name": "N"}]},
    {"presets": [{"id": " ", "name": "N"}]},
    {"presets": [{"id": "x" * 201, "name": "N"}]},
    {"presets": [{"id": "1", "name": " "}]},
    {"presets": [{"id": "1", "name": "x" * 201}]},
    {"presets": [{"id": "1", "name": 5}]},
    *[{"presets": [{"id": "1", "name": "N", "archived": value}]} for value in (None, "false", 0, 1)],
    {"presets": [{"id": "1", "name": "N"}] * 1001},
])
def test_malformed_payload(client, admin, site, upstream, payload):
    upstream(lambda request: httpx.Response(200, json=payload))
    response = client.post(f"/api/sites/{site[0]}/presets", headers=admin, json={"ai_api_key": TRANSIENT_KEY})
    assert response.status_code == 502
    assert response.json() == {"detail": "Preset provider returned an invalid response"}


@pytest.mark.parametrize("content", [b"not json", b"\xff", b'{"presets":[{"id":NaN,"name":"N"}]}', b"[" * 2000])
def test_invalid_json(client, admin, site, upstream, content):
    upstream(lambda request: httpx.Response(200, content=content))
    assert client.post(f"/api/sites/{site[0]}/presets", headers=admin,
                       json={"ai_api_key": TRANSIENT_KEY}).status_code == 502


class Chunks(httpx.AsyncByteStream):
    async def __aiter__(self):
        for _ in range(17):
            yield b" " * 65536
        pytest.fail("Response must stop reading after exceeding limit")


def test_streaming_size_limit(client, admin, site, upstream):
    upstream(lambda request: httpx.Response(200, stream=Chunks()))
    response = client.post(f"/api/sites/{site[0]}/presets", headers=admin, json={"ai_api_key": TRANSIENT_KEY})
    assert response.status_code == 502


def test_limits_accept_boundary(client, admin, site, upstream):
    content = json.dumps({"presets": [{"id": "x" * 200, "name": "n" * 200}] * 1000}).encode()
    content += b" " * (api.MAX_PRESETS_BYTES - len(content))
    upstream(lambda request: httpx.Response(200, content=content))
    response = client.post(f"/api/sites/{site[0]}/presets", headers=admin, json={"ai_api_key": TRANSIENT_KEY})
    assert response.status_code == 200
    assert len(response.json()["presets"]) == 1000


@pytest.mark.parametrize("status,expected", [(401, 400), (403, 400), (429, 503), (500, 502), (404, 502), (302, 502), (204, 502)])
def test_provider_status_sanitized(client, admin, site, app, upstream, status, expected):
    save_key(client, admin, site[0])
    before = snapshot(app)
    calls = upstream(lambda request: httpx.Response(status, text=f"provider-private {SAVED_KEY} {TRANSIENT_KEY}",
                                                   headers={"Location": "https://other.example", "Retry-After": SAVED_KEY}))
    response = client.post(f"/api/sites/{site[0]}/presets", headers=admin, json={})
    assert response.status_code == expected
    assert len(calls) == 1
    assert all(secret not in response.text for secret in (SAVED_KEY, TRANSIENT_KEY, "provider-private"))
    assert SAVED_KEY not in str(response.headers)
    assert snapshot(app) == before


@pytest.mark.parametrize("error,expected", [(httpx.ConnectError, 502), (httpx.ReadError, 502),
    (httpx.RemoteProtocolError, 502), (httpx.DecodingError, 502),
    (httpx.ConnectTimeout, 504), (httpx.ReadTimeout, 504)])
def test_network_failures_sanitized(client, admin, site, upstream, error, expected):
    def handler(request):
        raise error(f"provider-private {SAVED_KEY} {TRANSIENT_KEY}", request=request)

    upstream(handler)
    response = client.post(f"/api/sites/{site[0]}/presets", headers=admin, json={"ai_api_key": TRANSIENT_KEY})
    assert response.status_code == expected
    assert all(secret not in response.text for secret in (SAVED_KEY, TRANSIENT_KEY, "provider-private"))


@pytest.mark.parametrize("phase", ["headers", "stream", "combined"])
def test_overall_deadline_cancels_and_closes(client, admin, site, upstream, monkeypatch, phase):
    assert api.PRESETS_TIMEOUT == 10.0
    # Keep the regression fast while exercising the real asyncio timeout and
    # cancellation rather than manufacturing an HTTPX timeout exception.
    monkeypatch.setattr(api, "PRESETS_TIMEOUT", 0.12)
    state = {"chunks": 0, "cancelled": False, "closed": False, "handler_done": False}

    class SlowDrip(httpx.AsyncByteStream):
        async def __aiter__(self):
            try:
                while True:
                    await asyncio.sleep(0.01)
                    state["chunks"] += 1
                    yield b" "
            except asyncio.CancelledError:
                state["cancelled"] = True
                raise

        async def aclose(self):
            state["closed"] = True

    async def handler(request):
        state["loop"] = asyncio.get_running_loop()
        try:
            if phase == "headers":
                await asyncio.sleep(10)
            elif phase == "combined":
                await asyncio.sleep(0.08)
            return httpx.Response(200, stream=SlowDrip())
        except asyncio.CancelledError:
            state["cancelled"] = True
            raise
        finally:
            state["handler_done"] = True

    upstream(handler)
    started = time.monotonic()
    response = client.post(f"/api/sites/{site[0]}/presets", headers=admin,
                           json={"ai_api_key": TRANSIENT_KEY})
    assert time.monotonic() - started < 2
    assert response.status_code == 504
    assert response.json() == {"detail": "Preset provider timed out; try again later"}
    assert TRANSIENT_KEY not in response.text
    assert state["cancelled"] and state["handler_done"]
    assert state["loop"].is_closed()
    if phase != "headers":
        assert state["chunks"] >= 2
        assert state["closed"]
