"""VPS-side optional statistics reporting, distinct from backend endpoint tests."""
from unittest.mock import Mock

import pytest

from agent.agent import Agent
from templates.python.site_statistics import report_statistics


@pytest.mark.parametrize("links,average", [
    (0, None), (0, 0), (9007199254740991, 1000000000), (12, 2.5),
])
def test_statistics_exact_payload_and_response(links, average):
    agent = Agent.__new__(Agent)
    agent.request = Mock(return_value={"site_id": "site"})
    assert agent.report_statistics(links, average) == {"site_id": "site"}
    agent.request.assert_called_once_with("POST", "/statistics", json={
        "links_sent_successfully": links, "average_messages_per_chat": average,
    })


@pytest.mark.parametrize("links,average", [
    (-1, None), (True, None), (False, None), (1.0, None),
    (9007199254740992, None), (float("nan"), None), (float("inf"), None),
    (None, None), ("1", None), (1, -1), (1, True), (1, False),
    (1, float("nan")), (1, float("inf")), (1, -float("inf")),
    (1, 1000000000.1), (1, "2"), (1, 10 ** 500),
])
def test_invalid_statistics_never_calls_api(links, average):
    agent = Agent.__new__(Agent)
    agent.request = Mock()
    with pytest.raises(ValueError):
        agent.report_statistics(links, average)
    agent.request.assert_not_called()


def test_template_helper_uses_existing_request():
    request = Mock(return_value={"updated_at": "received"})
    assert report_statistics(request, 42, None) == {"updated_at": "received"}
    request.assert_called_once_with("POST", "/statistics", json={
        "links_sent_successfully": 42, "average_messages_per_chat": None,
    })


def test_both_statistics_arguments_required():
    request = Mock()
    with pytest.raises(TypeError):
        report_statistics(request, 1)
    request.assert_not_called()
