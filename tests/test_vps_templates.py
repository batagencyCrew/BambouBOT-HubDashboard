"""Language parity against a real hub and isolated rclone cloud destination."""
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import time

import pytest
import requests

ROOT = Path(__file__).resolve().parents[1]


def eventually(callback, timeout=55):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            value = callback()
            if value:
                return value
        except (requests.RequestException, KeyError, IndexError, FileNotFoundError, json.JSONDecodeError):
            pass
        time.sleep(0.2)
    raise AssertionError("Timed out waiting for VPS template integration state")


@pytest.fixture(scope="module")
def go_template_binary(tmp_path_factory):
    if not shutil.which("go"):
        pytest.skip("Go toolchain required")
    binary = tmp_path_factory.mktemp("go-template") / "site-agent"
    subprocess.run(["go", "build", "-o", str(binary), "."], cwd=ROOT / "templates/go", check=True, capture_output=True)
    return binary


@pytest.mark.parametrize("language", ["python", "node", "go"])
def test_template_enrollment_commands_file_deletions_and_backups(language, tmp_path, request):
    if not shutil.which("rclone"):
        pytest.skip("rclone required for full parity test")
    if language == "node" and not shutil.which("node"):
        pytest.skip("Node.js required")
    if language == "go":
        command = [str(request.getfixturevalue("go_template_binary"))]
    elif language == "node":
        command = [shutil.which("node"), str(ROOT / "templates/node/main.mjs")]
    else:
        command = [sys.executable, str(ROOT / "templates/python/main.py")]

    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
    origin = f"http://127.0.0.1:{port}"
    cloud = tmp_path / "cloud"
    cloud.mkdir()
    cloud_config = tmp_path / "rclone.conf"
    cloud_config.write_text(f"[qa]\ntype = alias\nremote = {cloud}\n")
    cloud_config.chmod(0o600)
    code = tmp_path / "codebase"
    code.mkdir()
    (code / "automation.txt").write_text("Only a harmless integration fixture\n")
    runtime = tmp_path / "runtime"
    runtime.mkdir(mode=0o700)
    (runtime / "config.json").write_text(json.dumps({"ai_api_key": "fixture-ai-key", "number_of_workers": 1, "ai_preset_id": "fixture-preset"}))
    (runtime / "proxies.txt").write_text("socks5://local-user:local-pass@proxy.example.com:1080\n")
    env = dict(os.environ, HUB_ADMIN_PASSWORD="template-parity-password-only", HUB_DATA_DIR=str(tmp_path / "hub"),
               HUB_RCLONE_CONFIG=str(cloud_config), HUB_BACKUP_WORKER_ENABLED="true")
    for key in ("HUB_ENCRYPTION_KEY", "HUB_SIGNING_KEY", "HUB_CORS_ORIGINS"):
        env.pop(key, None)
    agent = None
    session = requests.Session()
    with (tmp_path / "services.log").open("w") as log:
        hub = subprocess.Popen([sys.executable, "-m", "uvicorn", "backend.app:app", "--host", "127.0.0.1", "--port", str(port)],
                               cwd=ROOT, env=env, stdout=log, stderr=log)
        try:
            eventually(lambda: requests.get(origin + "/api/health", timeout=2).ok)
            token = requests.post(origin + "/api/auth/login", json={"password": env["HUB_ADMIN_PASSWORD"]}, timeout=5).json()["access_token"]
            session.headers["Authorization"] = "Bearer " + token

            def api(method, path, **kwargs):
                response = session.request(method, origin + "/api" + path, timeout=10, **kwargs)
                response.raise_for_status()
                return response.json() if response.content else None

            destination = api("POST", "/backup-destinations", json={"name": language + " parity cloud", "remote": "qa", "folder": "Templates"})
            created = api("POST", "/sites", json={"name": language + " parity VPS", "url": "https://example.com"})
            site_id = created["site"]["id"]
            base = f"/sites/{site_id}"
            api("PUT", base + "/backup-config", json={"enabled": True, "interval_minutes": 15, "destination_ids": [destination["id"]]})
            agent_env = dict(env, HUB_URL=origin, HUB_AGENT_TOKEN=created["agent_token"], HUB_RUNTIME_DIR=str(runtime),
                             HUB_STATE_DIR=str(tmp_path / "state"), HUB_BACKUP_DIR=str(code))
            # Do not expose the hub administrator password to a template process.
            agent_env.pop("HUB_ADMIN_PASSWORD", None)
            agent = subprocess.Popen(command, cwd=ROOT / "templates" / language, env=agent_env, stdout=log, stderr=log)

            def local_enrolled():
                config = api("GET", base + "/config")
                return config["has_ai_api_key"] and config["ai_preset_id"] == "fixture-preset" and len(api("GET", base + "/proxies")) == 1

            eventually(local_enrolled)
            eventually(lambda: api("GET", base)["status"] == "healthy")
            eventually(lambda: (runtime / ".sync.json").exists())
            eventually(lambda: (runtime / "backup-config.json").exists())
            for filename in ("config.json", "proxies.txt", ".sync.json", "backup-config.json"):
                assert (runtime / filename).stat().st_mode & 0o777 == 0o600
                assert created["agent_token"] not in (runtime / filename).read_text()
            assert "captcha_api_key" not in json.loads((runtime / "config.json").read_text())
            backup_settings = json.loads((runtime / "backup-config.json").read_text())
            assert backup_settings["enabled"] is True and backup_settings["interval_minutes"] == 15
            assert backup_settings["destination_ids"] == [destination["id"]]

            def lifecycle(action):
                dispatched = api("POST", base + "/commands", json={"action": action})
                eventually(lambda: any(item["id"] == dispatched["id"] and item["status"] == "completed"
                                       for item in api("GET", base + "/commands")))

            lifecycle("start")
            # Harmless template workers may truthfully be idle awaiting real jobs.
            eventually(lambda: any(worker["status"] in ("running", "idle") for worker in api("GET", base + "/workers")))
            api("PUT", base + "/config", json={"number_of_workers": 2, "ai_preset_id": "dashboard-preset", "ai_api_key": "replacement-ai-key"})
            proxy = api("GET", base + "/proxies")[0]
            api("DELETE", base + "/proxies/" + proxy["id"])
            lifecycle("restart")

            def files_updated():
                local = json.loads((runtime / "config.json").read_text())
                return local["number_of_workers"] == 2 and local["ai_preset_id"] == "dashboard-preset" and local["ai_api_key"] == "replacement-ai-key" and (runtime / "proxies.txt").read_text() == ""

            eventually(files_updated)
            eventually(lambda: len([item for item in api("GET", base + "/workers")
                                    if item["status"] in ("running", "idle")]) == 2)
            api("PUT", base + "/config", json={"number_of_workers": 1, "ai_preset_id": "dashboard-preset", "ai_api_key": ""})
            lifecycle("restart")
            eventually(lambda: json.loads((runtime / "config.json").read_text())["ai_api_key"] == "")

            def scheduled_completed():
                return next((item for item in api("GET", base + "/backups")["backups"]
                             if item["source"] == "scheduled" and item["status"] == "completed"), None)

            scheduled = eventually(scheduled_completed, timeout=75)
            assert (cloud / "Templates" / site_id / scheduled["id"] / scheduled["filename"]).is_file()
            api("PUT", base + "/backup-config", json={"enabled": False, "interval_minutes": 15, "destination_ids": [destination["id"]]})

            requested = api("POST", base + "/backups/request", json={})

            def backup_completed():
                history = api("GET", base + "/backups")
                linked = next((item for item in history["requests"] if item["id"] == requested["id"] and item["status"] == "uploaded"), None)
                return next((item for item in history["backups"] if linked and item["id"] == linked["backup_id"] and item["status"] == "completed"), None)

            backup = eventually(backup_completed, timeout=75)
            cloud_file = cloud / "Templates" / site_id / backup["id"] / backup["filename"]
            assert cloud_file.is_file() and cloud_file.stat().st_size > 0
            lifecycle("stop")
            eventually(lambda: all(item["status"] not in ("running", "idle") for item in api("GET", base + "/workers")))
            assert agent.poll() is None
            # A restored stale file/checkpoint cannot resurrect deleted proxies.
            agent.terminate()
            agent.wait(timeout=20)
            (runtime / "proxies.txt").write_text("stale.example.com:8080\n")
            (runtime / ".sync.json").unlink(missing_ok=True)
            agent = subprocess.Popen(command, cwd=ROOT / "templates" / language, env=agent_env, stdout=log, stderr=log)
            eventually(lambda: (runtime / "proxies.txt").read_text() == "")
            assert api("GET", base + "/proxies") == []
        except Exception as exc:
            log.flush()
            tail = "\n".join((tmp_path / "services.log").read_text().splitlines()[-60:])
            raise AssertionError(f"{language} template failed: {exc}\nLast service log lines:\n{tail}") from exc
        finally:
            if agent:
                agent.terminate()
                try:
                    agent.wait(timeout=20)
                except subprocess.TimeoutExpired:
                    agent.kill()
                    agent.wait()
            session.close()
            hub.terminate()
            try:
                hub.wait(timeout=15)
            except subprocess.TimeoutExpired:
                hub.kill()
                hub.wait()
