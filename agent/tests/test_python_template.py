import importlib.util
import os
from pathlib import Path
import sys
import threading

from agent import agent as supervisor


def test_no_flag_launch_reads_environment_and_absolute_worker(tmp_path, monkeypatch):
    entrypoint = Path(__file__).resolve().parents[2] / "templates" / "python" / "main.py"
    spec = importlib.util.spec_from_file_location("python_template", entrypoint)
    template = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(template)
    source = tmp_path / "codebase"
    source.mkdir()
    state, runtime = tmp_path / "state", tmp_path / "runtime"
    values = {"HUB_URL": "http://localhost:8000", "HUB_AGENT_TOKEN": "environment-only-token",
              "HUB_RUNTIME_DIR": str(runtime), "HUB_STATE_DIR": str(state),
              "HUB_BACKUP_DIR": str(source)}
    for key, value in values.items():
        monkeypatch.setenv(key, value)
    monkeypatch.delenv("HUB_WORKER_COMMAND", raising=False)
    monkeypatch.setattr(sys, "argv", [str(entrypoint)])
    monkeypatch.setattr(supervisor.signal, "signal", lambda *args: None)
    captured = {}

    class FakeAgent:
        def __init__(self, hub, token, command, state_dir, backup_dir, backup_max_bytes, runtime_dir):
            captured.update(hub=hub, token=token, command=command, state_dir=state_dir,
                            backup_dir=backup_dir, runtime_dir=runtime_dir)
            self.stop_event = threading.Event()

        def run(self):
            captured["ran"] = True

    monkeypatch.setattr(supervisor, "Agent", FakeAgent)
    template.main()
    assert captured["ran"]
    assert captured["hub"] == values["HUB_URL"]
    assert captured["token"] == values["HUB_AGENT_TOKEN"]
    assert captured["state_dir"] == str(state)
    assert captured["runtime_dir"] == str(runtime)
    assert captured["backup_dir"] == str(source)
    worker_path = Path(captured["command"][1])
    assert worker_path.is_absolute() and worker_path.is_file()
    assert worker_path.name == "exampleworker.py"


def test_dotenv_beside_entrypoint_does_not_override_exports(tmp_path, monkeypatch):
    monkeypatch.setattr(os, "environ", os.environ.copy())
    entrypoint = Path(__file__).resolve().parents[2] / "templates" / "python" / "main.py"
    spec = importlib.util.spec_from_file_location("python_template_env", entrypoint)
    template = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(template)
    script = tmp_path / "starter"
    script.mkdir()
    (script / ".env").write_text("HUB_URL=https://file.example\nHUB_AGENT_TOKEN=file-token\nHUB_STATE_DIR=./file-state\n")
    other = tmp_path / "cwd"
    other.mkdir()
    (other / ".env").write_text("HUB_URL=https://wrong.example\n")
    monkeypatch.chdir(other)
    monkeypatch.setattr(template, "__file__", str(script / "main.py"))
    monkeypatch.setattr(sys, "argv", [str(script / "main.py")])
    monkeypatch.delenv("HUB_URL", raising=False)
    monkeypatch.delenv("HUB_STATE_DIR", raising=False)
    monkeypatch.setenv("HUB_AGENT_TOKEN", "exported-token")
    captured = {}
    monkeypatch.setattr(template, "agent_main", lambda: captured.update(
        hub=os.environ["HUB_URL"], token=os.environ["HUB_AGENT_TOKEN"], argv=list(sys.argv)))
    template.main()
    assert captured["hub"] == "https://file.example"
    assert captured["token"] == "exported-token"
    assert captured["argv"][-2:] == ["--state-dir", "./file-state"]
