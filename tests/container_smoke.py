"""Optional Docker runtime + backup/restore test. Build hubdashboard-hub first."""
import json
import subprocess
import time
from uuid import uuid4

import requests


def docker(*args, **kwargs):
    return subprocess.run(["docker", *args], check=True, capture_output=True, **kwargs).stdout


def main():
    tag = "hub-qa-" + uuid4().hex[:12]
    volumes = [tag + "-source", tag + "-restored"]
    containers = []
    image = "hubdashboard-hub"
    password = "container-smoke-only-password"

    def start(volume, suffix):
        name = tag + suffix
        containers.append(name)
        docker("run", "--rm", "-d", "--name", name, "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
               "-e", "HUB_ADMIN_PASSWORD=" + password, "-v", volume + ":/app/data", "-p", "127.0.0.1::8000", image)
        mappings = json.loads(docker("inspect", name))[0]["NetworkSettings"]["Ports"]["8000/tcp"]
        origin = "http://127.0.0.1:" + mappings[0]["HostPort"]
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            try:
                if requests.get(origin + "/api/health", timeout=1).ok:
                    return name, origin
            except requests.RequestException:
                pass
            time.sleep(0.1)
        raise RuntimeError(docker("logs", name).decode())

    try:
        for volume in volumes:
            docker("volume", "create", volume)
        name, origin = start(volumes[0], "-original")
        assert "Bambou" in requests.get(origin, timeout=5).text
        token = requests.post(origin + "/api/auth/login", json={"password": password}, timeout=5).json()["access_token"]
        headers = {"Authorization": "Bearer " + token}
        response = requests.post(origin + "/api/sites", headers=headers, json={"name": "Backup test", "url": "https://example.com"}, timeout=5)
        response.raise_for_status()
        site = response.json()
        response = requests.put(origin + "/api/sites/" + site["site"]["id"] + "/config", headers=headers,
                                json={"number_of_workers": 1, "ai_preset_id": "backup-test", "ai_api_key": "encrypted-test-key"}, timeout=5)
        response.raise_for_status()
        docker("exec", name, "rclone", "version")
        docker("exec", name, "python", "-c",
               "from pathlib import Path; p=Path('/app/data/qa-cloud'); p.mkdir(); "
               "c=Path('/app/data/rclone.conf'); c.write_text('[qa]\\ntype = alias\\nremote = /app/data/qa-cloud\\n'); c.chmod(0o600)")
        destination = requests.post(origin + "/api/backup-destinations", headers=headers,
                                    json={"name": "Container cloud fixture", "remote": "qa", "folder": "Backups"}, timeout=10)
        destination.raise_for_status()
        base = "/api/sites/" + site["site"]["id"]
        configured = requests.put(origin + base + "/backup-config", headers=headers,
                                  json={"enabled": False, "interval_minutes": 1440, "destination_ids": [destination.json()["id"]]}, timeout=5)
        configured.raise_for_status()
        payload = b"opaque binary backup\x00\xff"
        uploaded = requests.post(origin + "/api/agent/backups/upload", params={"filename": "fixture.bin"},
                                 headers={"Authorization": "Bearer " + site["agent_token"], "Content-Type": "application/octet-stream"},
                                 data=payload, timeout=10)
        uploaded.raise_for_status()
        backup_id = uploaded.json()["id"]
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            history = requests.get(origin + base + "/backups", headers=headers, timeout=5).json()
            if any(item["id"] == backup_id and item["status"] == "completed" for item in history["backups"]):
                break
            time.sleep(0.2)
        else:
            raise AssertionError("Container cloud copy did not complete")
        cloud_file = "/app/data/qa-cloud/Backups/" + site["site"]["id"] + "/" + backup_id + "/fixture.bin"
        assert docker("exec", name, "python", "-c", "import sys; from pathlib import Path; sys.stdout.buffer.write(Path(sys.argv[1]).read_bytes())", cloud_file) == payload
        docker("stop", name)
        archive = docker("run", "--rm", "--cap-drop", "ALL", "-v", volumes[0] + ":/app/data",
                         "--entrypoint", "tar", image, "-C", "/app/data", "-czf", "-", ".")
        docker("run", "--rm", "-i", "--cap-drop", "ALL", "-v", volumes[1] + ":/app/data",
               "--entrypoint", "tar", image, "-C", "/app/data", "--no-same-owner", "-xzf", "-", input=archive)
        _, restored = start(volumes[1], "-restored")
        # Both the hashed agent token and decryption key must survive recovery.
        response = requests.get(restored + "/api/agent/config", headers={"Authorization": "Bearer " + site["agent_token"]}, timeout=5)
        response.raise_for_status()
        assert response.json()["ai_api_key"] == "encrypted-test-key"
        assert requests.get(restored + "/api/sites", headers=headers, timeout=5).status_code == 200
        cached = requests.get(restored + base + "/backups/" + backup_id + "/download", headers=headers, timeout=5)
        cached.raise_for_status()
        assert cached.content == payload
        print("Container smoke passed: non-root runtime, encrypted persistence, rclone cloud routing, backup and restore")
    finally:
        for name in containers:
            subprocess.run(["docker", "stop", name], capture_output=True)
        for volume in volumes:
            subprocess.run(["docker", "volume", "rm", volume], capture_output=True)


if __name__ == "__main__":
    main()
