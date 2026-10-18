"""Real HTTP + agent + local worker lifecycle test, isolated from production data."""
import os
from pathlib import Path
import socket
import subprocess
import sys
import time

import requests

ROOT = Path(__file__).resolve().parents[1]


def wait_until(callback, timeout=40):
    deadline = time.monotonic() + timeout
    last_error = None
    while time.monotonic() < deadline:
        try:
            result = callback()
            if result:
                return result
        except (requests.RequestException, KeyError, IndexError) as exc:
            last_error = exc
        time.sleep(0.25)
    raise AssertionError(f"Timed out waiting for integration state; last error: {last_error}")


def test_real_hub_agent_lifecycle(tmp_path):
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    origin = f"http://127.0.0.1:{port}"
    env = dict(os.environ, HUB_ADMIN_PASSWORD="integration-test-password-only",
               HUB_DATA_DIR=str(tmp_path / "hub"))
    # Keep externally configured production keys/settings out of this test.
    for key in ("HUB_ENCRYPTION_KEY", "HUB_SIGNING_KEY", "HUB_CORS_ORIGINS"):
        env.pop(key, None)
    agent = None
    with (tmp_path / "hub.log").open("w") as log:
        hub = subprocess.Popen([sys.executable, "-m", "uvicorn", "backend.app:app",
                                "--host", "127.0.0.1", "--port", str(port)],
                               cwd=ROOT, env=env, stdout=log, stderr=log)
        try:
            wait_until(lambda: requests.get(origin + "/api/health", timeout=2).status_code == 200)
            response = requests.post(origin + "/api/auth/login",
                                     json={"password": env["HUB_ADMIN_PASSWORD"]}, timeout=5)
            response.raise_for_status()
            admin = requests.Session()
            admin.headers["Authorization"] = "Bearer " + response.json()["access_token"]

            def api(method, path, **kwargs):
                result = admin.request(method, origin + "/api" + path, timeout=5, **kwargs)
                result.raise_for_status()
                return result.json() if result.content else None

            created = api("POST", "/sites", json={"name": "Integration VPS", "url": "https://example.com"})
            site_id = created["site"]["id"]
            base = f"/sites/{site_id}"
            api("PUT", base + "/config", json={"number_of_workers": 1, "ai_preset_id": "test", "ai_api_key": "test-secret"})
            agent_env = dict(env, HUB_URL=origin, HUB_AGENT_TOKEN=created["agent_token"])
            agent = subprocess.Popen([sys.executable, "agent/agent.py", "--state-dir", str(tmp_path / "agent"),
                                      "--command", f"{sys.executable} {ROOT / 'agent/demo_worker.py'}"],
                                     cwd=ROOT, env=agent_env, stdout=log, stderr=log)
            wait_until(lambda: api("GET", base)["status"] == "healthy")

            def command(action):
                cmd = api("POST", base + "/commands", json={"action": action})
                wait_until(lambda: any(item["id"] == cmd["id"] and item["status"] == "completed"
                                       for item in api("GET", base + "/commands")))

            command("start")
            wait_until(lambda: any(w["status"] == "running" for w in api("GET", base + "/workers")))
            command("restart")
            command("stop")
            wait_until(lambda: api("GET", base + "/workers") == [])
            assert agent.poll() is None
            assert api("GET", base + "/config")["has_ai_api_key"] is True
            api("DELETE", base)
            admin.close()
        except Exception as exc:
            log.flush()
            raise AssertionError((tmp_path / "hub.log").read_text()) from exc
        finally:
            if agent is not None:
                agent.terminate()
                try:
                    agent.wait(timeout=15)
                except subprocess.TimeoutExpired:
                    agent.kill()
                    agent.wait()
            hub.terminate()
            try:
                hub.wait(timeout=10)
            except subprocess.TimeoutExpired:
                hub.kill()
                hub.wait()
