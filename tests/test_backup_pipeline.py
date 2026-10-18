"""Real HTTP, agent packaging, and rclone routing to an isolated local alias."""
import hashlib
import io
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tarfile
import time

import pytest
import requests

ROOT = Path(__file__).resolve().parents[1]


def wait_for(callback, seconds=60):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        try:
            result = callback()
            if result:
                return result
        except (requests.RequestException, KeyError, IndexError):
            pass
        time.sleep(0.2)
    raise AssertionError("Timed out waiting for backup pipeline state")


@pytest.mark.skipif(shutil.which("rclone") is None, reason="rclone required for real cloud-router test")
def test_binary_upload_scheduled_and_on_demand_cloud_routing(tmp_path):
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
    origin = f"http://127.0.0.1:{port}"
    cloud = tmp_path / "cloud"
    cloud.mkdir()
    rclone_config = tmp_path / "rclone.conf"
    rclone_config.write_text(f"[qa]\ntype = alias\nremote = {cloud}\n")
    rclone_config.chmod(0o600)
    source = tmp_path / "script"
    source.mkdir()
    (source / "main.py").write_text("print('backup fixture')\n")
    (source / ".env").write_text("EXAMPLE_SECRET=fixture-only\n")
    env = dict(os.environ, HUB_ADMIN_PASSWORD="backup-integration-only", HUB_DATA_DIR=str(tmp_path / "hub"),
               HUB_RCLONE_CONFIG=str(rclone_config), HUB_BACKUP_WORKER_ENABLED="true",
               HUB_BACKUP_MAX_UPLOAD_BYTES=str(4 * 1024 * 1024), HUB_BACKUP_MAX_STORAGE_BYTES=str(20 * 1024 * 1024),
               HUB_BACKUP_TRANSFER_TIMEOUT_SECONDS="60")
    for key in ("HUB_ENCRYPTION_KEY", "HUB_SIGNING_KEY", "HUB_CORS_ORIGINS"):
        env.pop(key, None)
    agent = None
    with (tmp_path / "server.log").open("w") as log:
        server = subprocess.Popen([sys.executable, "-m", "uvicorn", "backend.app:app", "--host", "127.0.0.1",
                                   "--port", str(port)], cwd=ROOT, env=env, stdout=log, stderr=log)
        session = requests.Session()
        try:
            wait_for(lambda: requests.get(origin + "/api/health", timeout=2).status_code == 200)
            token = session.post(origin + "/api/auth/login", json={"password": env["HUB_ADMIN_PASSWORD"]}, timeout=5).json()["access_token"]
            session.headers["Authorization"] = "Bearer " + token

            def api(method, path, **kwargs):
                response = session.request(method, origin + "/api" + path, timeout=10, **kwargs)
                response.raise_for_status()
                return response.json() if response.content else None

            remotes = api("GET", "/backup-remotes")
            assert remotes["available"] and "qa" in remotes["remotes"]
            destination = api("POST", "/backup-destinations", json={"name": "Isolated test cloud", "remote": "qa", "folder": "Backups"})
            created = api("POST", "/sites", json={"name": "Backup pipeline", "url": "https://example.com"})
            site_id = created["site"]["id"]
            base = f"/sites/{site_id}"
            config = {"enabled": False, "interval_minutes": 15, "destination_ids": [destination["id"]]}
            api("PUT", base + "/backup-config", json=config)
            agent_headers = {"Authorization": "Bearer " + created["agent_token"], "Content-Type": "application/octet-stream"}
            # Larger than the ordinary 1 MiB JSON-body limit; no archive format.
            content = os.urandom(2 * 1024 * 1024 + 127)
            response = requests.post(origin + "/api/agent/backups/upload", params={"filename": "raw-file.bin"},
                                     headers=agent_headers, data=io.BytesIO(content), timeout=30)
            response.raise_for_status()
            assert response.status_code == 201
            backup = response.json()
            assert backup["size_bytes"] == len(content)
            assert backup["sha256"] == hashlib.sha256(content).hexdigest()

            def completed(source_type):
                backups = api("GET", base + "/backups")["backups"]
                return next((item for item in backups if item["source"] == source_type and item["status"] == "completed"), None)

            completed_direct = wait_for(lambda: completed("direct"))
            cloud_file = cloud / "Backups" / site_id / backup["id"] / "raw-file.bin"
            assert cloud_file.read_bytes() == content
            downloaded = session.get(origin + "/api" + base + f"/backups/{backup['id']}/download", timeout=10)
            downloaded.raise_for_status()
            assert downloaded.content == content
            assert "attachment" in downloaded.headers["Content-Disposition"]

            api("PUT", base + "/backup-config", json={**config, "enabled": True})
            agent_env = dict(env, HUB_URL=origin, HUB_AGENT_TOKEN=created["agent_token"])
            agent = subprocess.Popen([sys.executable, "agent/agent.py", "--state-dir", str(tmp_path / "agent"),
                                      "--runtime-dir", str(tmp_path / "runtime"),
                                      "--backup-dir", str(source), "--command", f"{sys.executable} {ROOT / 'agent/demo_worker.py'}"],
                                     cwd=ROOT, env=agent_env, stdout=log, stderr=log)
            scheduled = wait_for(lambda: completed("scheduled"))
            assert api("GET", base + "/backup-config")["agent_configured"] is True
            with tarfile.open(cloud / "Backups" / site_id / scheduled["id"] / scheduled["filename"]) as archive:
                assert archive.extractfile("script/main.py").read() == b"print('backup fixture')\n"
                assert archive.extractfile("script/.env").read() == b"EXAMPLE_SECRET=fixture-only\n"

            api("PUT", base + "/backup-config", json=config)
            requested = api("POST", base + "/backups/request", json={})
            ondemand = wait_for(lambda: completed("on_demand"))
            requests_list = api("GET", base + "/backups")["requests"]
            assert any(item["id"] == requested["id"] and item["status"] == "uploaded" and item["backup_id"] == ondemand["id"]
                       for item in requests_list)
            assert agent.poll() is None

            api("DELETE", base + f"/backups/{completed_direct['id']}/local")
            assert cloud_file.exists(), "Eviction must never delete cloud copies"
            assert session.get(origin + "/api" + base + f"/backups/{backup['id']}/download", timeout=5).status_code == 404
            usage = api("GET", "/backup-storage")
            assert 0 < usage["used_bytes"] < len(content)
        except Exception as exc:
            log.flush()
            raise AssertionError((tmp_path / "server.log").read_text()) from exc
        finally:
            if agent:
                agent.terminate()
                try:
                    agent.wait(timeout=15)
                except subprocess.TimeoutExpired:
                    agent.kill()
                    agent.wait()
            session.close()
            server.terminate()
            try:
                server.wait(timeout=15)
            except subprocess.TimeoutExpired:
                server.kill()
                server.wait()
