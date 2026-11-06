from datetime import datetime, timedelta, timezone

from hub import alerts

from .conftest import agent_headers

WORKER = "6f0e7a3c-8a2b-4b7f-9d41-0e3c7a4f1b2d"


def _titles(owner):
    return sorted(a["title"] for a in owner.get("/api/alerts").json())


def test_default_rules_and_offline_resolution(owner, site, app):
    alerts.ensure_default_rules(app.state.db)
    db = app.state.db
    db.execute("INSERT INTO agent_reports(site_id, last_seen_at) VALUES(%s, now() - interval '10 minutes')", (site["id"],))
    db.execute("UPDATE sites SET desired_state='running' WHERE id=%s", (site["id"],))
    alerts.evaluate(app)
    assert _titles(owner) == ["alpha is offline"]
    alerts.evaluate(app)  # deduplicated
    assert len(owner.get("/api/alerts").json()) == 1
    db.execute("UPDATE agent_reports SET last_seen_at=now() WHERE site_id=%s", (site["id"],))
    alerts.evaluate(app)
    assert owner.get("/api/alerts").json() == []
    assert owner.get("/api/alerts", params={"status": "resolved"}).json()[0]["title"] == "alpha is offline"


def test_worker_error_and_idle(owner, site, app):
    alerts.ensure_default_rules(app.state.db)
    db = app.state.db
    db.execute("UPDATE sites SET desired_state='running' WHERE id=%s", (site["id"],))
    owner.post("/api/agent/v2/batch", headers=agent_headers(site), json={"presence": {"workers": [
        {"id": WORKER, "name": "worker-1", "status": "error", "detail": {"reason": "captcha loop"}}]}})
    alerts.evaluate(app)
    assert "alpha / worker-1 is error" in _titles(owner)
    # Idle for 20 minutes (back-dated samples) trips the 15-minute idle rule.
    db.execute("UPDATE workers SET status='idle' WHERE id=%s", (WORKER,))
    db.execute("DELETE FROM worker_samples WHERE worker_id=%s", (WORKER,))
    db.execute("INSERT INTO worker_samples(site_id, worker_id, ts, status) VALUES(%s,%s,now() - interval '20 minutes','idle')",
               (site["id"], WORKER))
    alerts.evaluate(app)
    titles = _titles(owner)
    assert "alpha / worker-1 is idle" in titles and "alpha / worker-1 is error" not in titles


def test_error_spike_cost_and_balance(owner, site, app):
    db = app.state.db
    db.execute("INSERT INTO alert_rules(name, kind, params) VALUES('spike','error_spike','{\"count\":3,\"minutes\":5}'),"
               "('spend','cost_daily','{\"amount\":1}'),('bal','balance_low','{}')")
    owner.post("/api/agent/v2/batch", headers=agent_headers(site), json={
        "logs": [{"level": "error", "message": f"fail {i}"} for i in range(3)],
        "costs": [{"event_id": "receipt-0001", "provider": "openai", "amount": 2.5}],
        "balances": [{"provider": "capsolver", "balance": 1, "low_threshold": 2}]})
    alerts.evaluate(app)
    titles = _titles(owner)
    assert any(t.startswith("alpha: 3 errors") for t in titles)
    assert "alpha spent 2.50 USD today" in titles
    assert "alpha: capsolver balance low" in titles


def test_proxy_failing_and_rule_crud(owner, site, app):
    created = owner.post("/api/alerts/rules", json={"name": "proxies", "kind": "proxy_failing", "params": {"percent": 50},
                                                     "channels": [{"platform": "discord", "chat_id": "1:2"}]})
    assert created.status_code == 201, created.text
    owner.post("/api/agent/v2/batch", headers=agent_headers(site), json={"proxies": [
        {"key": "a", "label": "p1", "state": "blocked"}, {"key": "b", "label": "p2", "state": "timeout"},
        {"key": "c", "label": "p3", "state": "ok"}]})
    alerts.evaluate(app)
    assert "alpha: 2/3 proxies failing" in _titles(owner)
    delivery = app.state.db.one("SELECT platform, channel FROM alert_deliveries")
    assert delivery == {"platform": "discord", "channel": "1:2"}
    assert owner.post("/api/alerts/rules", json={"name": "x", "kind": "nonsense"}).status_code == 400
    assert owner.delete(f"/api/alerts/rules/{created.json()['id']}").status_code == 200


def test_mute_expires(owner, site, app):
    owner.post("/api/agent/v2/batch", headers=agent_headers(site), json={"issues": [{"title": "Stuck", "key": "k1"}]})
    alert = owner.get("/api/alerts").json()[0]
    owner.post(f"/api/alerts/{alert['id']}/mute", json={"minutes": 5})
    assert owner.get("/api/alerts").json()[0]["status"] == "muted"
    app.state.db.execute("UPDATE alerts SET muted_until=%s WHERE id=%s",
                         (datetime.now(timezone.utc) - timedelta(minutes=1), alert["id"]))
    alerts.evaluate(app)
    assert owner.get("/api/alerts").json()[0]["status"] == "open"
