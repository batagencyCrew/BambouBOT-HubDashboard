import json
import os
import sys

import pytest

from agent import agent as module
Agent = module.Agent


@pytest.fixture
def agent(tmp_path):
    instance = Agent("http://localhost:8000", "secret-token", [sys.executable, "-c", "import time; time.sleep(60)"], tmp_path,
                     runtime_dir=tmp_path / "runtime")
    instance.config = {"number_of_workers": 1, "ai_preset_id": "test", "proxies": []}
    yield instance
    instance.stop_workers()
    instance.backup_runner.close()
    instance.session.close()


def test_supervisor_lifecycle(agent):
    agent.running = True
    agent.reconcile()
    assert len(agent.workers) == 1
    process = agent.workers["worker-1"][0]
    assert process.poll() is None
    agent.stop_workers()
    assert process.poll() is not None
    assert not agent.workers


def test_command_persist_dedup_and_refresh(agent, monkeypatch):
    calls = []
    commands = [{"id": "one", "action": "restart"}]

    def request(method, path, **kwargs):
        calls.append((method, path, kwargs))
        if path == "/commands":
            return commands
        if path == "/config":
            return {"number_of_workers": 0, "ai_preset_id": "new", "proxies": [],
                    "revision": 0, "local_sync_initialized": False}
        if path == "/local-sync":
            return {"number_of_workers": 0, "ai_preset_id": "new", "proxies": [],
                    "revision": 1, "local_sync_initialized": True}
        return {}

    monkeypatch.setattr(agent, "request", request)
    agent.commands()
    assert agent.config["ai_preset_id"] == "new"
    assert json.loads(agent.state_file.read_text())["one"]["status"] == "completed"
    assert os.stat(agent.state_file).st_mode & 0o777 == 0o600
    calls.clear()
    agent.commands()
    assert not any(path == "/config" for _, path, _ in calls)
    assert any(path == "/commands/one/ack" for _, path, _ in calls)


def test_failed_ack_retried_without_repeating_action(agent, monkeypatch):
    actions = []
    attempts = []

    def request(method, path, **kwargs):
        if path == "/commands":
            return [{"id": "two", "action": "stop"}]
        attempts.append(path)
        if len(attempts) == 1:
            raise RuntimeError("network failure")
        return {}

    monkeypatch.setattr(agent, "request", request)
    monkeypatch.setattr(agent, "stop_workers", lambda: actions.append("stop"))
    with pytest.raises(RuntimeError):
        agent.commands()
    agent.commands()
    assert actions == ["stop"]
    assert len(attempts) == 2


def test_hard_worker_limit(agent):
    agent.running = True
    agent.config["number_of_workers"] = 101
    with pytest.raises(ValueError):
        agent.reconcile()


def test_worker_environment_removes_agent_token(agent, monkeypatch):
    monkeypatch.setenv("HUB_AGENT_TOKEN", "never-pass-this")
    monkeypatch.setenv("CAPTCHA_API_KEY", "never-pass-this-either")
    captured = {}
    real_popen = module.subprocess.Popen

    def popen(*args, **kwargs):
        captured.update(kwargs["env"])
        return real_popen(*args, **kwargs)

    monkeypatch.setattr(module.subprocess, "Popen", popen)
    agent.spawn("worker-1")
    assert "HUB_AGENT_TOKEN" not in captured
    assert "CAPTCHA_API_KEY" not in captured
    assert captured["HUB_WORKER_ID"] == agent.telemetry_id("worker-1")


def test_worker_ipc_reports_real_tasks_and_sanitized_error(agent, monkeypatch):
    agent.command = [sys.executable, "-c", "import os,socket; "
                     "s=socket.socket(fileno=int(os.environ['HUB_WORKER_EVENTS_FD'])); "
                     "s.send(b'task_completed'); s.send(b'error')"]
    agent.spawn("worker-1")
    agent.workers["worker-1"][0].wait(timeout=5)
    calls = []

    def request(method, path, **kwargs):
        calls.append((path, kwargs["json"]))
        return {"desired_state": "running"}

    monkeypatch.setattr(agent, "request", request)
    agent.heartbeat()
    heartbeat = next(body for path, body in calls if path == "/heartbeat")
    assert heartbeat["workers"][0]["tasks_completed"] == 1
    assert any(body["message"] == "Worker automation hook failed; inspect local implementation"
               for path, body in calls if path == "/errors")


def test_state_survives_restart(agent):
    agent.completed["done"] = {"status": "completed"}
    agent.persist()
    second = Agent(agent.hub, "token", agent.command, agent.state_dir, runtime_dir=agent.local_files.directory)
    assert "done" in second.completed
    second.session.close()
    second.backup_runner.close()


def test_failed_worker_reports_one_sanitized_event(agent, monkeypatch):
    agent.command = [sys.executable, "-c", "raise SystemExit(3)"]
    agent.spawn("worker-1")
    agent.workers["worker-1"][0].wait(timeout=5)
    events = []

    def request(method, path, **kwargs):
        if path == "/errors":
            events.append(kwargs["json"])
            return {"id": "event-id"}
        return {"desired_state": "running"}

    monkeypatch.setattr(agent, "request", request)
    agent.heartbeat()
    agent.heartbeat()
    assert len(events) == 1
    assert events[0]["worker_id"] == agent.telemetry_id("worker-1")
    assert "code 3" in events[0]["message"]


def test_shutdown_uses_one_shared_deadline(agent, monkeypatch):
    events = []

    class Process:
        def __init__(self, pid):
            self.pid = pid

        def wait(self, timeout=None):
            events.append(("wait", self.pid, timeout))

    agent.workers = {"a": (Process(101), None), "b": (Process(102), None)}
    clock = iter([0, 0, 8])
    monkeypatch.setattr(module.time, "monotonic", lambda: next(clock))
    monkeypatch.setattr(module.os, "killpg", lambda pid, sig: events.append(("signal", pid, sig)))
    agent.stop_workers()
    assert events[:2] == [("signal", 101, module.signal.SIGTERM), ("signal", 102, module.signal.SIGTERM)]
    waits = [event[2] for event in events if event[0] == "wait" and event[2] is not None]
    assert waits == [10, 2]
    assert agent.workers == {}


def test_backup_startup_failure_does_not_abort_supervisor(agent, monkeypatch):
    agent.stop_event.set()
    monkeypatch.setattr(agent.backup_runner, "start", lambda: (_ for _ in ()).throw(RuntimeError("backup thread unavailable")))
    agent.run()
