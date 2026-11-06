from fastapi.testclient import TestClient

from .conftest import agent_headers, login, make_user


def test_body_limit(owner, site, app):
    app.state.settings.__dict__  # frozen dataclass; limit set at startup (4 MiB default)
    huge = {"logs": [{"level": "info", "message": "x" * 8000}] * 600}
    response = owner.post("/api/agent/v2/batch", json=huge, headers=agent_headers(site))
    assert response.status_code == 413


def test_session_cookie_is_httponly_and_strict(client):
    make_user(client)
    response = login(client)
    cookie = response.headers["set-cookie"].lower()
    assert "httponly" in cookie and "samesite=strict" in cookie


def test_password_change_revokes_sessions(client, owner):
    other = TestClient(client.app)
    login(other)
    assert other.get("/api/auth/me").status_code == 200
    changed = owner.post("/api/auth/password", json={"current_password": "correct horse battery",
                                                     "new_password": "a brand new password"})
    assert changed.status_code == 200
    assert other.get("/api/auth/me").status_code == 401


def test_disabled_user_cannot_use_session(client, owner):
    owner.post("/api/users", json={"username": "temp", "password": "temporary password", "role": "viewer"})
    temp = TestClient(client.app)
    login(temp, "temp", "temporary password")
    user_id = next(u["id"] for u in owner.get("/api/users").json() if u["username"] == "temp")
    owner.patch(f"/api/users/{user_id}", json={"disabled": True})
    assert temp.get("/api/sites").status_code == 401


def test_last_owner_cannot_be_demoted(owner):
    me = owner.get("/api/auth/me").json()["user"]
    assert owner.patch(f"/api/users/{me['id']}", json={"role": "viewer"}).status_code == 400


def test_revoked_site_token_rejected(owner, site):
    owner.post(f"/api/sites/{site['slug']}/tokens")
    assert owner.get("/api/agent/v2/whoami", headers=agent_headers(site)).status_code == 401


def test_bot_acts_as_linked_user(client, owner, site):
    token = owner.post("/api/service-tokens/bot").json()["token"]
    code = owner.post("/api/me/bot-link-code").json()["code"]
    bot = TestClient(client.app)
    bot.headers["Authorization"] = f"Bearer {token}"
    # Unlinked chat user: no hub access.
    assert bot.get("/api/sites", headers={"X-Bot-User": "telegram:42"}).status_code == 401
    assert bot.post("/api/bot/link", json={"platform": "telegram", "platform_user": "42", "code": code.lower()}).status_code == 200
    assert bot.post("/api/bot/link", json={"platform": "telegram", "platform_user": "43", "code": code}).status_code == 400  # one-time
    sites = bot.get("/api/sites", headers={"X-Bot-User": "telegram:42"})
    assert sites.status_code == 200 and sites.json()[0]["slug"] == site["slug"]
    sent = bot.post(f"/api/sites/{site['slug']}/commands", json={"action": "restart"}, headers={"X-Bot-User": "telegram:42"})
    assert sent.status_code == 201 and sent.json()["source"] == "bot"
    audit = owner.get("/api/audit").json()["items"]
    assert any(a["action"] == "command.restart" and a["source"] == "bot" for a in audit)
    # Without the service token the header means nothing.
    assert TestClient(client.app).get("/api/sites", headers={"X-Bot-User": "telegram:42"}).status_code == 401


def test_alert_delivery_queue(client, owner, site):
    token = owner.post("/api/service-tokens/bot").json()["token"]
    owner.put("/api/alerts/channels", json=[{"platform": "telegram", "chat_id": "-100123"}])
    owner.post("/api/agent/v2/batch", headers=agent_headers(site), json={"issues": [{"title": "Captcha balance empty"}]})
    bot = TestClient(client.app)
    bot.headers["Authorization"] = f"Bearer {token}"
    deliveries = bot.get("/api/bot/deliveries").json()
    assert deliveries[0]["channel"] == "-100123" and deliveries[0]["title"] == "Captcha balance empty"
    bot.post(f"/api/bot/deliveries/{deliveries[0]['id']}", json={"ok": True})
    assert bot.get("/api/bot/deliveries").json() == []
