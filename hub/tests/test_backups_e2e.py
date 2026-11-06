"""Backup pipeline with a real rclone 'local' remote: upload → copy → retention → classification."""

import io
import shutil
import tarfile
import time

import pytest

from .conftest import agent_headers

pytestmark = pytest.mark.skipif(shutil.which("rclone") is None, reason="rclone not installed")


def _archive() -> bytes:
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz") as tar:
        data = b"print('hello')\n"
        info = tarfile.TarInfo("bot.py")
        info.size = len(data)
        tar.addfile(info, io.BytesIO(data))
    return buffer.getvalue()


@pytest.fixture
def remote(app, tmp_path):
    root = tmp_path / "drive"
    root.mkdir()
    conf = tmp_path / "rclone.conf"
    conf.write_text(f"[gdrive]\ntype = alias\nremote = {root}\n")
    return root


def test_backup_copied_to_per_site_folder_and_pruned(owner, site, remote):
    dest = owner.post("/api/backup-destinations", json={"name": "Drive", "remote": "gdrive", "folder": "Bambou Backups"})
    assert dest.status_code == 201, dest.text
    config = owner.put(f"/api/sites/{site['slug']}/backups/config",
                       json={"enabled": True, "interval_minutes": 60, "destination_ids": [dest.json()["id"]], "keep_count": 2})
    assert config.status_code == 200, config.text
    backups = owner.app.state.backups
    for _ in range(3):
        upload = owner.post("/api/agent/v2/backups/upload", params={"source": "scheduled"}, content=_archive(),
                            headers={**agent_headers(site), "Content-Type": "application/octet-stream"})
        assert upload.status_code == 200, upload.text
        assert backups.run_due() == 1
        time.sleep(1.1)  # distinct second-resolution timestamps
    folder = remote / "Bambou Backups" / site["slug"]
    names = sorted(p.name for p in folder.iterdir())
    assert len(names) == 2 and all(n.startswith(f"{site['slug']}-") and n.endswith(".tar.gz") for n in names)
    listed = owner.get(f"/api/sites/{site['slug']}/backups").json()
    assert [b["status"] for b in listed] == ["completed"] * 3
    assert listed[0]["transfers"][0]["remote_path"].startswith(f"gdrive:Bambou Backups/{site['slug']}/")
    # Local staging copy removed after a successful copy.
    assert not listed[0]["local_available"]


def test_failed_transfer_backs_off_then_retry(owner, site, remote, tmp_path):
    dest = owner.post("/api/backup-destinations", json={"name": "Drive", "remote": "gdrive", "folder": "x"}).json()
    owner.put(f"/api/sites/{site['slug']}/backups/config",
              json={"enabled": True, "interval_minutes": 60, "destination_ids": [dest["id"]]})
    shutil.rmtree(remote)
    (tmp_path / "drive").write_text("not a directory")  # makes the alias target unusable
    owner.post("/api/agent/v2/backups/upload", params={"source": "manual"}, content=_archive(),
               headers={**agent_headers(site), "Content-Type": "application/octet-stream"})
    owner.app.state.backups.run_due()
    transfer = owner.get(f"/api/sites/{site['slug']}/backups").json()[0]["transfers"][0]
    assert transfer["status"] == "queued" and transfer["attempts"] == 1 and transfer["error"]
    # Not retried before its backoff.
    assert owner.app.state.backups.run_due() == 0


def test_upload_limits_are_permanent_errors(owner, site, app):
    app.state.backups.max_upload = 10
    big = owner.post("/api/agent/v2/backups/upload", params={"source": "manual", "size": "100"}, content=b"x" * 100,
                     headers={**agent_headers(site), "Content-Type": "application/octet-stream"})
    assert big.status_code == 413
    empty = owner.post("/api/agent/v2/backups/upload", params={"source": "manual"}, content=b"",
                       headers={**agent_headers(site), "Content-Type": "application/octet-stream"})
    assert empty.status_code == 400
