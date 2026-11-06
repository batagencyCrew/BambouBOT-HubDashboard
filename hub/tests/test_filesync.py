from fastapi.testclient import TestClient

from .conftest import agent_headers, login

ENV = "HUB_URL=https://hub\nAPI_KEY=secret-value\nWORKERS=2\n"


def _enroll(owner, site, path=".env", content=ENV, fmt=None):
    body = {"path": path, "content": content, "base_revision": 0}
    if fmt:
        body["format"] = fmt
    response = owner.post("/api/agent/v2/files/push", json=body, headers=agent_headers(site))
    assert response.status_code == 200, response.text
    return response.json()


def test_enroll_then_admin_edit_then_agent_apply(owner, site):
    assert _enroll(owner, site) == {"accepted": True, "revision": 1, "conflict": False}
    view = owner.get(f"/api/sites/{site['slug']}/files/content", params={"path": ".env"}).json()
    assert "secret-value" not in view["content"] and view["in_sync"]
    # Edit through the masked view: only WORKERS changes, secret preserved.
    edited = view["content"].replace("WORKERS=2", "WORKERS=5")
    put = owner.put(f"/api/sites/{site['slug']}/files/content", params={"path": ".env"},
                    json={"content": edited, "base_revision": 1})
    assert put.status_code == 200, put.text
    assert put.json()["revision"] == 2 and not put.json()["in_sync"]
    files = owner.get("/api/agent/v2/files", headers=agent_headers(site)).json()["files"]
    assert "API_KEY=secret-value" in files[0]["content"] and "WORKERS=5" in files[0]["content"]
    ack = owner.post("/api/agent/v2/files/ack", headers=agent_headers(site),
                     json={"path": ".env", "revision": 2, "sha256": files[0]["sha256"]})
    assert ack.json() == {"ok": True}
    assert owner.get(f"/api/sites/{site['slug']}/files").json()[0]["in_sync"] is True
    history = owner.get(f"/api/sites/{site['slug']}/files/history", params={"path": ".env"}).json()
    assert [h["action"] for h in history] == ["update", "initial"]
    assert history[0]["summary"]["changed"] == ["WORKERS"]


def test_stale_admin_edit_rejected(owner, site):
    _enroll(owner, site)
    stale = owner.put(f"/api/sites/{site['slug']}/files/content", params={"path": ".env"},
                      json={"content": "A=1\n", "base_revision": 0})
    assert stale.status_code == 409


def test_local_change_and_conflict(owner, site):
    _enroll(owner, site)
    # Local edit on VPS while hub unchanged -> accepted as revision 2.
    local = owner.post("/api/agent/v2/files/push", headers=agent_headers(site),
                       json={"path": ".env", "content": ENV + "EXTRA=1\n", "base_revision": 1}).json()
    assert local == {"accepted": True, "revision": 2, "conflict": False}
    # Admin edits (rev 3) and VPS edits based on rev 2 at the same time -> conflict, hub wins.
    owner.patch(f"/api/sites/{site['slug']}/files/content", params={"path": ".env"},
                json={"set": {"WORKERS": "9"}, "base_revision": 2})
    clash = owner.post("/api/agent/v2/files/push", headers=agent_headers(site),
                       json={"path": ".env", "content": "WORKERS=1\n", "base_revision": 2}).json()
    assert clash["conflict"] is True and clash["revision"] == 3
    history = owner.get(f"/api/sites/{site['slug']}/files/history", params={"path": ".env"}).json()
    assert history[0]["action"] == "local-conflict"


def test_reveal_requires_permission_and_is_audited(client, owner, site):
    _enroll(owner, site)
    revealed = owner.get(f"/api/sites/{site['slug']}/files/content", params={"path": ".env", "reveal": True}).json()
    assert "secret-value" in revealed["content"]
    assert any(a["action"] == "file.reveal" for a in owner.get("/api/audit").json()["items"])
    owner.post("/api/users", json={"username": "op", "password": "operator password", "role": "operator"})
    op = TestClient(client.app)
    login(op, "op", "operator password")
    assert op.get(f"/api/sites/{site['slug']}/files/content", params={"path": ".env", "reveal": True}).status_code == 403
    assert "secret-value" not in op.get(f"/api/sites/{site['slug']}/files/content", params={"path": ".env"}).json()["content"]


def test_invalid_content_rejected(owner, site):
    _enroll(owner, site, path="config.json", content='{"a": 1}\n')
    bad = owner.put(f"/api/sites/{site['slug']}/files/content", params={"path": "config.json"},
                    json={"content": "{not json", "base_revision": 1})
    assert bad.status_code == 400 and "Invalid JSON" in bad.json()["detail"]
    assert owner.post("/api/agent/v2/files/push", headers=agent_headers(site),
                      json={"path": "../../etc/passwd", "content": "x", "base_revision": 0}).status_code == 422


def test_restore_previous_revision(owner, site):
    _enroll(owner, site)
    owner.patch(f"/api/sites/{site['slug']}/files/content", params={"path": ".env"}, json={"set": {"WORKERS": "7"}})
    restored = owner.post(f"/api/sites/{site['slug']}/files/restore", params={"path": ".env", "revision": 1})
    assert restored.status_code == 200 and restored.json()["revision"] == 3
    content = owner.get(f"/api/sites/{site['slug']}/files/content", params={"path": ".env", "reveal": True}).json()["content"]
    assert content == ENV


def test_proxy_patch_needs_proxy_permission(client, owner, site):
    _enroll(owner, site, path="proxies.txt", content="http://1.1.1.1:80\n")
    out = owner.patch(f"/api/sites/{site['slug']}/files/content", params={"path": "proxies.txt"},
                      json={"add_proxies": ["2.2.2.2:81:u:p"]}).json()
    assert [p["host"] for p in out["parsed"]] == ["1.1.1.1", "2.2.2.2"]
    assert out["parsed"][1]["url"] == "http://u:********@2.2.2.2:81"
