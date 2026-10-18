"""VPS-side archive and scheduling tests, separate from hub backup tests."""
import io
import hashlib
import json
import os
from pathlib import Path
import tarfile
import threading
import time

import pytest
import requests

from agent.backups import BackupCancelled, BackupRunner, BackupUploadUncertain, LimitedWriter, UploadReader


@pytest.fixture
def runner(tmp_path):
    source = tmp_path / "codebase"
    source.mkdir()
    (source / "main.py").write_text("print('example')\n")
    (source / ".env").write_text("EXAMPLE=private-test-value\n")
    nested = source / "nested"
    nested.mkdir()
    (nested / "module.py").write_text("value = 42\n")
    stop = threading.Event()
    instance = BackupRunner("http://localhost:8000", "test-token", source, source / "agent-state", stop)
    yield instance
    stop.set()
    instance.close()


def test_archive_includes_hidden_files_and_excludes_agent_state(runner, tmp_path):
    archive_path = tmp_path / "archive.tar.gz"
    (runner.state_dir / "private-state.txt").write_text("not part of the codebase")
    runner.pack(archive_path)
    assert archive_path.stat().st_mode & 0o777 == 0o600
    with tarfile.open(archive_path) as archive:
        names = archive.getnames()
        assert "codebase/main.py" in names
        assert "codebase/.env" in names
        assert "codebase/nested/module.py" in names
        assert not any("agent-state" in name for name in names)
        assert archive.extractfile("codebase/.env").read() == b"EXAMPLE=private-test-value\n"


def test_nested_runtime_excluded_but_codebase_configuration_included(runner, tmp_path):
    runner.runtime_dir = runner.source / "runtime"
    runner.runtime_dir.mkdir()
    (runner.runtime_dir / "config.json").write_text('{"ai_api_key":"private"}')
    (runner.source / "config.json").write_text('{"business_setting":true}')
    archive_path = tmp_path / "archive.tar.gz"
    runner.pack(archive_path)
    with tarfile.open(archive_path) as archive:
        assert "codebase/config.json" in archive.getnames()
        assert not any("/runtime" in name for name in archive.getnames())


def test_archive_preserves_symlinks_without_reading_external_target(runner, tmp_path):
    target = tmp_path / "outside-secret.txt"
    target.write_text("external data should not be copied")
    (runner.source / "link").symlink_to(target)
    archive_path = tmp_path / "archive.tar.gz"
    runner.pack(archive_path)
    with tarfile.open(archive_path) as archive:
        link = archive.getmember("codebase/link")
        assert link.issym()
        assert link.size == 0
        assert "outside-secret.txt" not in archive.getnames()


def test_archive_size_limit_and_temporary_cleanup(runner, monkeypatch):
    runner.max_bytes = 100
    (runner.source / "random.bin").write_bytes(os.urandom(10000))
    with pytest.raises(ValueError):
        runner.perform("scheduled")
    assert list(runner.scratch.glob("backup-*.tar.gz")) == []


def test_cancelled_pack_is_not_uploaded(runner, monkeypatch):
    runner.stop_event.set()
    monkeypatch.setattr(runner, "upload", lambda *args: pytest.fail("Must not upload cancelled archive"))
    with pytest.raises(BackupCancelled):
        runner.perform("scheduled")
    assert not list(runner.scratch.glob("backup-*.tar.gz"))


def test_streaming_reader_sets_length_and_observes_cancellation(tmp_path):
    path = tmp_path / "data.bin"
    path.write_bytes(b"x" * 200000)
    stop = threading.Event()
    with path.open("rb") as stream:
        reader = UploadReader(stream, stop)
        prepared = requests.Request("POST", "http://localhost/upload", data=reader).prepare()
        assert prepared.headers["Content-Length"] == "200000"
        assert "Transfer-Encoding" not in prepared.headers
        assert len(reader.read()) == 65536
        stop.set()
        with pytest.raises(BackupCancelled):
            reader.read(10)


def test_upload_success_persists_schedule_without_credentials(runner, monkeypatch):
    def upload(path, source, request_id):
        assert path.exists()
        assert source == "on_demand" and request_id == "request-id"
        return {"id": "backup-id", "status": "queued"}

    monkeypatch.setattr(runner, "upload", upload)
    result = runner.perform("on_demand", "request-id")
    assert result["status"] == "queued"
    saved = json.loads(runner.state_file.read_text())
    assert saved["last_uploaded"] > 0
    assert "test-token" not in runner.state_file.read_text()
    assert runner.state_file.stat().st_mode & 0o777 == 0o600
    assert not list(runner.scratch.glob("backup-*.tar.gz"))
    restored = BackupRunner(runner.hub, "token", runner.source, runner.state_dir, runner.stop_event)
    assert restored.last_uploaded == runner.last_uploaded
    restored.close()


def test_scheduled_backup_is_due_once_and_survives_restart(runner, monkeypatch):
    calls = []
    monkeypatch.setattr(runner, "api", lambda method, path, **kwargs: [] if path == "/backup-requests" else {})

    def upload(path, source, request_id):
        calls.append(source)
        return {"id": "backup-id"}

    monkeypatch.setattr(runner, "upload", upload)
    runner.tick({"enabled": True, "interval_minutes": 1440})
    runner.tick({"enabled": True, "interval_minutes": 1440})
    assert calls == ["scheduled"]


def test_missing_source_reports_on_demand_failure(runner, monkeypatch):
    runner.source = None
    calls = []

    def api(method, path, **kwargs):
        calls.append((path, kwargs))
        return [{"id": "request-id"}] if path == "/backup-requests" else {}

    monkeypatch.setattr(runner, "api", api)
    runner.tick({"enabled": False, "interval_minutes": 1440})
    status = next(kwargs["json"] for path, kwargs in calls if path == "/backup-status")
    assert status["configured"] is False and status["next_backup_at"] is None
    ack = next(kwargs["json"] for path, kwargs in calls if path.endswith("/ack"))
    assert ack["status"] == "failed" and "--backup-dir" in ack["message"]


def test_scheduled_upload_failure_backs_off(runner, monkeypatch):
    monkeypatch.setattr(runner, "api", lambda method, path, **kwargs: [] if path == "/backup-requests" else {})
    attempts = []

    def fail(*args):
        attempts.append(True)
        raise RuntimeError("private details never logged")

    monkeypatch.setattr(runner, "perform", fail)
    runner.tick({"enabled": True, "interval_minutes": 1440})
    runner.tick({"enabled": True, "interval_minutes": 1440})
    assert len(attempts) == 1
    assert runner.retry_at >= time.time() + 290


def test_manual_backups_do_not_depend_on_periodic_toggle(runner, monkeypatch):
    attempts = []
    monkeypatch.setattr(runner, "api", lambda method, path, **kwargs: [{"id": "request-id"}] if path == "/backup-requests" else {})
    monkeypatch.setattr(runner, "perform", lambda source, request_id: attempts.append((source, request_id)))
    runner.tick({"enabled": False, "interval_minutes": 1440})
    assert attempts == [("on_demand", "request-id")]


def test_invalid_source_and_interval_rejected(runner):
    runner.source = Path("/")
    assert not runner.configured()
    runner.source = runner.state_dir / "nested-source"
    runner.source.mkdir()
    assert not runner.configured()
    runner.source = runner.state_dir
    assert not runner.configured()
    with pytest.raises(ValueError):
        runner.tick({"enabled": True, "interval_minutes": 0})


def test_writer_never_exceeds_limit():
    output = io.BytesIO()
    writer = LimitedWriter(output, 3, threading.Event())
    assert writer.write(b"abc") == 3
    with pytest.raises(ValueError):
        writer.write(b"d")
    assert output.getvalue() == b"abc"


def test_large_file_archive_uses_bounded_writes(runner, tmp_path, monkeypatch):
    block = os.urandom(256 * 1024)
    expected = hashlib.sha256()
    with (runner.source / "large.bin").open("wb") as stream:
        for _ in range(32):
            stream.write(block)
            expected.update(block)
    write_sizes = []
    real_write = LimitedWriter.write

    def write(writer, data):
        write_sizes.append(len(data))
        return real_write(writer, data)

    monkeypatch.setattr(LimitedWriter, "write", write)
    path = tmp_path / "large.tar.gz"
    runner.pack(path)
    assert max(write_sizes) <= 128 * 1024
    received = hashlib.sha256()
    with tarfile.open(path) as archive:
        stream = archive.extractfile("codebase/large.bin")
        while chunk := stream.read(65536):
            received.update(chunk)
    assert received.digest() == expected.digest()


def test_runtime_at_source_root_does_not_exclude_codebase(runner, tmp_path):
    runner.runtime_dir = runner.source
    path = tmp_path / "source-with-runtime.tar.gz"
    runner.pack(path)
    with tarfile.open(path) as archive:
        assert "codebase/main.py" in archive.getnames()
        assert not any("agent-state" in name for name in archive.getnames())


@pytest.mark.parametrize("kind", ["file", "directory"])
def test_concurrent_symlink_replacement_cannot_escape_source(runner, tmp_path, monkeypatch, kind):
    outside = tmp_path / "external"
    outside.mkdir()
    (outside / "secret.txt").write_text("must not be read")
    real_open = os.open
    target = "main.py" if kind == "file" else "nested"
    replaced = False

    def raced_open(path, flags, *args, **kwargs):
        nonlocal replaced
        if path == target and "dir_fd" in kwargs and not replaced:
            replaced = True
            original = runner.source / target
            original.rename(runner.source / (target + "-original"))
            original.symlink_to(outside / "secret.txt" if kind == "file" else outside)
        return real_open(path, flags, *args, **kwargs)

    monkeypatch.setattr(os, "open", raced_open)
    with pytest.raises(OSError):
        runner.perform("scheduled")
    assert replaced
    assert not list(runner.scratch.glob("backup-*.tar.gz"))


@pytest.mark.parametrize("state", ["{invalid-json", '{"last_uploaded": "invalid"}', '{"last_uploaded": NaN}', '{"last_uploaded": 1e100}', '{"last_uploaded":' + '9' * 1000 + '}'])
def test_bad_checkpoint_only_pauses_periodic_backups(runner, state, monkeypatch):
    runner.state_file.write_text(state)
    restored = BackupRunner(runner.hub, "token", runner.source, runner.state_dir, runner.stop_event)
    try:
        assert restored.state_issue
        monkeypatch.setattr(restored, "api", lambda method, path, **kwargs: [] if path == "/backup-requests" else {})
        monkeypatch.setattr(restored, "perform", lambda *args: pytest.fail("Periodic backup must be paused"))
        restored.tick({"enabled": True, "interval_minutes": 15})
    finally:
        restored.close()


def test_persist_failure_after_acceptance_does_not_acknowledge_upload_failed(runner, monkeypatch):
    calls = []

    def api(method, path, **kwargs):
        calls.append(path)
        return [{"id": "request-id"}] if path == "/backup-requests" else {}

    monkeypatch.setattr(runner, "api", api)
    monkeypatch.setattr(runner, "upload", lambda *args: {"id": "accepted-id"})
    monkeypatch.setattr(runner, "persist", lambda: (_ for _ in ()).throw(OSError("disk not writable")))
    runner.tick({"enabled": False, "interval_minutes": 15})
    assert runner.pending_persist and runner.state_issue
    assert not any(path.endswith("/ack") for path in calls)
    assert runner.last_uploaded > 0
    monkeypatch.setattr(runner, "persist", lambda: None)
    monkeypatch.setattr(runner, "api", lambda method, path, **kwargs: [] if path == "/backup-requests" else {})
    runner.tick({"enabled": False, "interval_minutes": 15})
    assert not runner.pending_persist and not runner.state_issue


def test_ambiguous_upload_is_reconciled_not_marked_failed(runner, monkeypatch):
    calls = []

    def api(method, path, **kwargs):
        calls.append(path)
        return [{"id": "request-id"}] if path == "/backup-requests" else {}

    monkeypatch.setattr(runner, "api", api)
    monkeypatch.setattr(runner, "upload", lambda *args: (_ for _ in ()).throw(requests.ConnectionError("lost response")))
    runner.tick({"enabled": False, "interval_minutes": 15})
    assert not any(path.endswith("/ack") for path in calls)
    assert runner.request_retry_at["request-id"] > time.time()


def test_live_backup_thread_owns_its_session(runner, monkeypatch):
    class BlockedThread:
        def join(self, timeout):
            assert timeout == 5

        def is_alive(self):
            return True

    runner.thread = BlockedThread()
    monkeypatch.setattr(runner.session, "close", lambda: pytest.fail("Do not close another thread's session"))
    runner.close()
    runner.thread = None
    monkeypatch.undo()


@pytest.mark.parametrize("accepted", [True, False])
def test_cleanup_failure_preserves_accepted_or_uncertain_outcome(runner, monkeypatch, accepted):
    real_unlink = Path.unlink

    def unlink(path, *args, **kwargs):
        if path.parent == runner.scratch:
            raise PermissionError("temporary storage unavailable")
        return real_unlink(path, *args, **kwargs)

    def upload(*args):
        if accepted:
            return {"id": "accepted"}
        raise requests.ConnectionError("uncertain outcome")

    monkeypatch.setattr(Path, "unlink", unlink)
    monkeypatch.setattr(runner, "upload", upload)
    if accepted:
        assert runner.perform("on_demand", "request-id")["id"] == "accepted"
    else:
        with pytest.raises(BackupUploadUncertain):
            runner.perform("on_demand", "request-id")
    assert runner.io_issue


def test_backup_scratch_creation_failure_is_isolated(runner, tmp_path, monkeypatch):
    real_mkdir = Path.mkdir

    def mkdir(path, *args, **kwargs):
        if path.name == "backup-tmp":
            raise PermissionError("not writable")
        return real_mkdir(path, *args, **kwargs)

    monkeypatch.setattr(Path, "mkdir", mkdir)
    isolated = BackupRunner(runner.hub, "token", runner.source, tmp_path / "isolated-state", threading.Event())
    try:
        assert isolated.io_issue and not isolated.configured()
    finally:
        isolated.close()


def test_stale_archive_cleanup_failure_does_not_break_start(runner, monkeypatch):
    stale = runner.scratch / "backup-stale.tar.gz"
    stale.write_bytes(b"stale")
    real_unlink = Path.unlink

    def unlink(path, *args, **kwargs):
        if path == stale:
            raise PermissionError("not writable")
        return real_unlink(path, *args, **kwargs)

    monkeypatch.setattr(Path, "unlink", unlink)
    runner.stop_event.set()
    runner.start()
    runner.close()
    assert runner.io_issue
