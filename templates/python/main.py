#!/usr/bin/env python3
"""Run the shared supervisor with this template's locally selected worker."""
from pathlib import Path
import os
import shlex
import sys

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from agent.agent import main as agent_main


def main():
    # Optional local .env; CLI arguments override the environment. Never download code.
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).with_name(".env"), override=False)
    arguments = sys.argv[1:]
    if not any(arg == "--command" or arg.startswith("--command=") for arg in arguments):
        command = os.environ.get("HUB_WORKER_COMMAND") or shlex.join([
            sys.executable, str(Path(__file__).with_name("exampleworker.py"))])
        arguments.extend(["--command", command])
    if not any(arg == "--state-dir" or arg.startswith("--state-dir=") for arg in arguments):
        arguments.extend(["--state-dir", os.environ.get("HUB_STATE_DIR", "./agent-state")])
    sys.argv = [sys.argv[0], *arguments]
    agent_main()


if __name__ == "__main__":
    main()
