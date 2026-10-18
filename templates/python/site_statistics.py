"""Use from trusted supervisor-side code with its existing request helper.

Keep this template inside the repository, with the repository root on sys.path
(as main.py does). Worker processes do not have the agent token.
"""
from agent.statistics_reporting import report_statistics

__all__ = ["report_statistics"]
