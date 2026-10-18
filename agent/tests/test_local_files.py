import json
import os
import threading

import pytest

from agent.local_files import HubError, LocalFiles
from agent.backups import BackupRunner


def configuration(revision=0, initialized=False, **kwargs):
    return {"revision": revision, "local_sync_initialized": initialized,
            "number_of_workers": 1, "ai_api_key": "", "ai_preset_id": "default",
            "proxies": [], **kwargs}


def test_enrollment_without_files_still_posts_and_checkpoints(tmp_path):
    files = LocalFiles(tmp_path / "runtime")
    calls = []

    def api(method, path, **kwargs):
        calls.append((method, path, kwargs))
        return configuration(1, True) if method == "POST" else configuration()

    files.fetch(api)
    assert calls == [("GET", "/config", {}),
                     ("POST", "/local-sync", {"json": {"expected_revision": 0}})]
    assert json.loads((files.directory / ".sync.json").read_text()) == {"initialized": True, "revision": 1}
    assert files.directory.stat().st_mode & 0o777 == 0o700
    assert all(path.stat().st_mode & 0o777 == 0o600 for path in files.directory.iterdir())


def test_import_allowlist_and_raw_proxies(tmp_path):
    files = LocalFiles(tmp_path)
    (tmp_path / "config.json").write_text(json.dumps({"ai_api_key": "local-key", "revision": 123,
        "captcha_api_key": "must-not-import", "token": "must-not-import", "unknown": "ignored"}))
    raw = "# my proxies\n\nhttp://u:p@localhost:8080\n"
    (tmp_path / "proxies.txt").write_text(raw)
    posts = []

    def api(method, path, **kwargs):
        if method == "POST":
            posts.append(kwargs["json"])
        return configuration(1, True) if method == "POST" else configuration()

    files.fetch(api)
    assert posts == [{"expected_revision": 0, "config": {"ai_api_key": "local-key"}, "proxies_content": raw}]
    assert "must-not-import" not in (tmp_path / "config.json").read_text()


def test_race_retries_once_without_local_data(tmp_path):
    files = LocalFiles(tmp_path)
    (tmp_path / "config.json").write_text('{"ai_api_key":"obsolete-local-key"}')
    posts = []
    gets = []

    def api(method, path, **kwargs):
        if method == "GET":
            gets.append(path)
            return configuration(0 if len(gets) == 1 else 5)
        posts.append(kwargs["json"])
        if len(posts) == 1:
            raise HubError(409)
        return configuration(6, True, ai_api_key="admin-value")

    files.fetch(api)
    assert len(gets) == 2
    assert posts[1] == {"expected_revision": 5}
    assert json.loads((tmp_path / "config.json").read_text())["ai_api_key"] == "admin-value"


def test_second_conflict_is_not_retried_or_published(tmp_path):
    files = LocalFiles(tmp_path)
    original = '{"number_of_workers":2}'
    (tmp_path / "config.json").write_text(original)
    posts = []

    def api(method, path, **kwargs):
        if method == "GET":
            return configuration()
        posts.append(kwargs)
        raise HubError(409)

    with pytest.raises(HubError):
        files.fetch(api)
    assert len(posts) == 2
    assert (tmp_path / "config.json").read_text() == original
    assert not (tmp_path / ".sync.json").exists()


@pytest.mark.parametrize("content", ['{broken secret', '[]', '{"number_of_workers":true}',
    '{"number_of_workers":101}', '{"ai_api_key":null}'])
def test_invalid_local_json_preserved_without_secret_exception(tmp_path, content):
    files = LocalFiles(tmp_path)
    (tmp_path / "config.json").write_text(content)
    calls = []

    def api(method, path, **kwargs):
        calls.append(method)
        return configuration()

    with pytest.raises(ValueError) as caught:
        files.fetch(api)
    assert "secret" not in str(caught.value)
    assert calls == ["GET"]
    assert (tmp_path / "config.json").read_text() == content
    assert not (tmp_path / ".sync.json").exists()


def test_invalid_proxy_rejected_by_hub_without_local_writes(tmp_path):
    files = LocalFiles(tmp_path)
    (tmp_path / "proxies.txt").write_text("invalid secret proxy")

    def api(method, path, **kwargs):
        if method == "POST":
            raise HubError(422)
        return configuration()

    with pytest.raises(HubError):
        files.fetch(api)
    assert (tmp_path / "proxies.txt").read_text() == "invalid secret proxy"
    assert not (tmp_path / "config.json").exists()
    assert not (tmp_path / ".sync.json").exists()


def test_deletions_authoritative_and_encoded_private_files(tmp_path):
    files = LocalFiles(tmp_path)
    first = configuration(1, True, ai_api_key="private-key", captcha_api_key="forbidden",
        token="forbidden", proxies=[{"url": "http://[::1]:8080", "username": "u@/", "password": "p:# %"}])
    files.publish(first)
    assert (tmp_path / "proxies.txt").read_text() == "http://u%40%2F:p%3A%23%20%25@[::1]:8080\n"
    (tmp_path / "config.json").chmod(0o666)
    (tmp_path / "proxies.txt").write_text("manual change must disappear")
    calls = []

    def api(method, path, **kwargs):
        calls.append(method)
        return configuration(2, True)

    files.fetch(api)
    assert calls == ["GET"]
    assert (tmp_path / "proxies.txt").read_text() == ""
    saved = json.loads((tmp_path / "config.json").read_text())
    assert saved["ai_api_key"] == "" and saved["revision"] == 2
    assert "captcha_api_key" not in saved and "token" not in saved
    assert (tmp_path / "config.json").stat().st_mode & 0o777 == 0o600


def test_lost_checkpoint_no_resurrection_or_invalid_stale_file_block(tmp_path):
    files = LocalFiles(tmp_path)
    (tmp_path / "config.json").write_text("invalid stale local file")
    (tmp_path / "proxies.txt").write_text("deleted proxies")
    posts = []

    def api(method, path, **kwargs):
        if method == "POST":
            posts.append(kwargs["json"])
        return configuration(7, True)

    files.fetch(api)
    assert posts == [{"expected_revision": 7}]
    assert (tmp_path / "proxies.txt").read_text() == ""


def test_checkpoint_published_last_and_not_on_failed_publication(tmp_path, monkeypatch):
    files = LocalFiles(tmp_path)
    writes = []
    original = files.atomic_write

    def write(name, value):
        writes.append(name)
        if name == "proxies.txt":
            raise OSError("disk full")
        original(name, value)

    monkeypatch.setattr(files, "atomic_write", write)
    with pytest.raises(OSError):
        files.publish(configuration(1, True))
    assert writes == ["config.json", "proxies.txt"]
    assert not (tmp_path / ".sync.json").exists()


def test_read_rejects_symlinks_and_publish_replaces_without_touching_target(tmp_path):
    directory = tmp_path / "runtime"
    files = LocalFiles(directory)
    target = tmp_path / "outside"
    target.write_text("untouched")
    (directory / "config.json").symlink_to(target)
    with pytest.raises(OSError):
        files.import_data()
    files.publish(configuration(1, True))
    assert target.read_text() == "untouched"
    assert not (directory / "config.json").is_symlink()


def test_backup_config_safe_private_snapshot(tmp_path, monkeypatch):
    runtime = tmp_path / "runtime"
    runner = BackupRunner("http://localhost", "super-secret-token", None, tmp_path / "state",
                          threading.Event(), runtime_dir=runtime)
    monkeypatch.setattr(runner, "api", lambda method, path, **kwargs: [] if path == "/backup-requests" else {})
    config = {"enabled": False, "interval_minutes": 1440, "destination_ids": ["destination-id"],
              "next_backup_at": None, "cloud_password": "forbidden"}
    try:
        runner.tick(config)
        snapshot = runtime / "backup-config.json"
        data = json.loads(snapshot.read_text())
        assert data == {key: value for key, value in config.items() if key != "cloud_password"}
        assert "super-secret-token" not in snapshot.read_text()
        assert "forbidden" not in snapshot.read_text()
        assert snapshot.stat().st_mode & 0o777 == 0o600
    finally:
        runner.close()
