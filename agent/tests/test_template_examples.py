import json
from pathlib import Path
import subprocess

import pytest


TEMPLATES = Path(__file__).resolve().parents[2] / "templates"


@pytest.mark.parametrize("language", ["python", "node", "go"])
def test_examples_against_actual_backend_local_config_model(language):
    # Optional backend dependencies are not required to run a standalone agent.
    backend = pytest.importorskip("backend.hub.app")
    config = json.loads((TEMPLATES / language / "config.example.json").read_text())
    parsed = backend.LocalConfig.model_validate(config)
    assert parsed.ai_preset_id == "default" and parsed.number_of_workers == 0
    assert parsed.ai_api_key.get_secret_value() == ""
    with pytest.raises(ValueError):
        backend.LocalConfig.model_validate({**config, "ai_preset_id": ""})


@pytest.mark.parametrize("language", ["python", "node", "go"])
def test_examples_are_safe_and_copy_commands_never_clobber(language, tmp_path):
    source = TEMPLATES / language
    config = json.loads((source / "config.example.json").read_text())
    # Known LocalConfig enrollment constraints; do not relax the backend for samples.
    assert set(config) == {"ai_api_key", "number_of_workers", "ai_preset_id"}
    assert isinstance(config["ai_api_key"], str)
    assert type(config["number_of_workers"]) is int and 0 <= config["number_of_workers"] <= 100
    assert isinstance(config["ai_preset_id"], str) and len(config["ai_preset_id"]) >= 1
    assert config == {"ai_api_key": "", "number_of_workers": 0, "ai_preset_id": "default"}
    assert all(not line.strip() or line.lstrip().startswith("#")
               for line in (source / "proxies.example.txt").read_text().splitlines())
    env = dict(line.split("=", 1) for line in (source / ".env.example").read_text().splitlines()
               if line and not line.startswith("#"))
    assert env["HUB_URL"].startswith("https://")
    assert env["HUB_AGENT_TOKEN"].startswith("replace-with-")
    for example, name in [(".env.example", ".env"), ("config.example.json", "config.json"),
                          ("proxies.example.txt", "proxies.txt")]:
        target = tmp_path / name
        subprocess.run(["cp", "--no-clobber", str(source / example), str(target)], check=True)
        assert target.read_bytes() == (source / example).read_bytes()
        target.write_text("existing-local-secret")
        subprocess.run(["cp", "--no-clobber", str(source / example), str(target)], check=True)
        assert target.read_text() == "existing-local-secret"
