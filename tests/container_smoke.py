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
        print("Container smoke passed: non-root startup, static UI, API, encrypted persistence, backup and restore")
    finally:
        for name in containers:
            subprocess.run(["docker", "stop", name], capture_output=True)
        for volume in volumes:
            subprocess.run(["docker", "volume", "rm", volume], capture_output=True)


if __name__ == "__main__":
    main()
