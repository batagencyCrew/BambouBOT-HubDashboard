"""Real processes: v2 hub (uvicorn) + bambou-agent + a script using the SDK."""

import json
import os
import secrets
import socket
import subprocess
import sys
import time
from pathlib import Path

import httpx
import pytest

ROOT = Path(__file__).resolve().parents[2]


def _free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _wait(predicate, timeout=30, interval=0.5):
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        try:
            last = predicate()
            if last:
                return last
        except Exception as exc:  # keep polling
            last = exc
        time.sleep(interval)
    raise AssertionError(f"Timed out; last={last!r}")


@pytest.fixture
def live_hub(database_url, tmp_path):
    port = _free_port()
    env = {**os.environ, "HUB_DATABASE_URL": database_url, "HUB_DATA_DIR": str(tmp_path / "hubdata"),
           "HUB_SECRET_KEY": secrets.token_hex(32), "HUB_SECURE_COOKIES": "false", "PYTHONPATH": str(ROOT)}
    proc = subprocess.Popen([sys.executable, "-m", "uvicorn", "hub.main:app", "--host", "127.0.0.1", "--port", str(port)],
                            cwd=ROOT, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    url = f"http://127.0.0.1:{port}"
    try:
        _wait(lambda: httpx.get(f"{url}/api/health").status_code == 200)
        subprocess.run([sys.executable, "-m", "hub.cli", "create-user", "owner", "--password", "correct horse battery"],
                       cwd=ROOT, env=env, check=True, capture_output=True)
        yield url
    finally:
        proc.terminate()
        proc.wait(10)


def test_agent_sdk_full_loop(live_hub, tmp_path):
    admin = httpx.Client(base_url=live_hub)
    assert admin.post("/api/auth/login", json={"username": "owner", "password": "correct horse battery"}).status_code == 200
    created = admin.post("/api/sites", json={"name": "Demo"}).json()
    token = created["agent_token"]

    script_dir = tmp_path / "script"
    script_dir.mkdir()
    (script_dir / "demo_script.py").write_text((ROOT / "sdk/python/examples/demo_script.py").read_text())
    (script_dir / "config.json").write_text(json.dumps({"workers": 2, "api_key": "sk-local-secret"}))
    (script_dir / ".env").write_text("CAPSOLVER_API_KEY=CAP-123\nMODE=fast\n")
    env = {**os.environ, "HUB_URL": live_hub, "HUB_AGENT_TOKEN": token,
           "PYTHONPATH": f"{ROOT / 'agent2'}:{ROOT / 'sdk/python'}"}
    agent = subprocess.Popen([sys.executable, "-m", "bambou_agent", "--script-dir", str(script_dir),
                              "--command", f"{sys.executable} demo_script.py", "--file", "config.json", "--file", ".env",
                              "--log-level", "INFO"],
                             env=env, stdout=open(tmp_path / "agent.log", "wb"), stderr=subprocess.STDOUT)
    try:
        # Files enrolled from the VPS, secrets masked in the hub view.
        files = _wait(lambda: (f := admin.get("/api/sites/demo/files").json()) and len(f) == 2 and f)
        assert {f["path"] for f in files} == {"config.json", ".env"}
        env_view = admin.get("/api/sites/demo/files/content", params={"path": ".env"}).json()
        assert "CAP-123" not in env_view["content"] and "MODE=fast" in env_view["content"]

        # Start: script spawned, workers + logs + metrics + costs arrive through the SDK.
        admin.post("/api/sites/demo/commands", json={"action": "start"})
        _wait(lambda: admin.get("/api/sites/demo").json()["workers"]["running"] + admin.get("/api/sites/demo").json()["workers"]["idle"] >= 2)
        _wait(lambda: admin.get("/api/costs", params={"site": "demo", "group_by": "provider"}).json()["totals"].get("USD", 0) > 0)
        providers = {r["key"] for r in admin.get("/api/costs", params={"site": "demo", "group_by": "provider"}).json()["rows"]}
        assert providers == {"demo-captcha", "openai"}
        _wait(lambda: any(l["message"] == "chat finished" and l["worker_name"]
                          for l in admin.get("/api/logs", params={"site": "demo"}).json()["items"]))
        _wait(lambda: admin.get("/api/balances", params={"site": "demo"}).json()[0]["low"])
        _wait(lambda: admin.get("/api/sites/demo/proxy-health").json())
        caps = _wait(lambda: admin.get("/api/sites/demo").json()["capabilities"]["commands"])
        assert caps[0]["name"] == "say_hello"

        # Custom command round trip.
        command = admin.post("/api/sites/demo/commands", json={"action": "custom:say_hello"}).json()
        done = _wait(lambda: (c := admin.get("/api/sites/demo/commands").json()[0]) and c["status"] == "completed" and c)
        assert done["id"] == command["id"] and "greeted" in done["result"]

        # Live worker count change.
        admin.post("/api/sites/demo/commands", json={"action": "set_workers", "args": {"count": 4}})
        _wait(lambda: sum(admin.get("/api/sites/demo").json()["workers"][k] for k in ("running", "idle")) >= 4, timeout=40)

        # Hub edit of config.json reaches the VPS file, keeping the masked secret.
        view = admin.get("/api/sites/demo/files/content", params={"path": "config.json"}).json()
        patched = admin.patch("/api/sites/demo/files/content", params={"path": "config.json"},
                              json={"set": {"workers": 3}, "base_revision": view["revision"]})
        assert patched.status_code == 200, patched.text
        _wait(lambda: json.loads((script_dir / "config.json").read_text()).get("workers") == 3)
        assert json.loads((script_dir / "config.json").read_text())["api_key"] == "sk-local-secret"
        _wait(lambda: admin.get("/api/sites/demo/files").json()[0]["in_sync"])

        # Local hand edit on the VPS flows up to the hub.
        (script_dir / ".env").write_text("CAPSOLVER_API_KEY=CAP-123\nMODE=slow\n")
        admin.post("/api/sites/demo/commands", json={"action": "reload_config"})
        _wait(lambda: "MODE=slow" in admin.get("/api/sites/demo/files/content", params={"path": ".env"}).json()["content"])

        # Stop: script process ends, workers reported stopped.
        admin.post("/api/sites/demo/commands", json={"action": "stop"})
        _wait(lambda: admin.get("/api/sites/demo").json()["process"].get("state") == "stopped", timeout=40)
    finally:
        agent.terminate()
        try:
            agent.wait(30)
        except subprocess.TimeoutExpired:
            agent.kill()
        log = (tmp_path / "agent.log").read_text()
        print("\n".join(l for l in log.splitlines() if "bambou-agent" in l or "Traceback" in l or "Error" in l)[-6000:])
