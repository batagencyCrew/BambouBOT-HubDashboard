import pytest

from agent.telemetry_reporting import report_ai_usage, report_chat, report_proxy_error

ID = "11111111-1111-4111-8111-111111111111"
CHAT = dict(event_id=ID, worker_id=ID, msgs_in=2, msgs_out=3, links=1,
            converted=False, duration=4.5)
USAGE = dict(event_id=ID, key_id="primary-alias", calls=5, error_429=1, error_502=0, latency_ms=12.5)


def test_exact_explicit_payloads_and_no_defaults_or_extra_fields():
    calls = []

    def request(method, path, **kwargs):
        calls.append((method, path, kwargs))
        return {"accepted": True}

    assert report_chat(request, **CHAT, proxy_id=ID, room="room-alias", random=False) == {"accepted": True}
    report_chat(request, **CHAT)
    report_ai_usage(request, **USAGE)
    report_proxy_error(request, worker_id=ID, proxy_id=ID, code="proxy_recovered")
    assert calls == [
        ("POST", "/chats", {"json": {**CHAT, "proxy_id": ID, "room": "room-alias", "random": False}}),
        ("POST", "/chats", {"json": CHAT}),
        ("POST", "/ai-usage", {"json": USAGE}),
        ("POST", "/errors", {"json": {"worker_id": ID, "proxy_id": ID, "code": "proxy_recovered",
                                       "level": "error", "message": "Proxy status event"}})]


@pytest.mark.parametrize("field,value", [("event_id", "secret"), ("worker_id", "bad"),
    ("msgs_in", True), ("links", -1), ("msgs_out", 2**53), ("converted", 1),
    ("duration", float("inf")), ("duration", 604801), ("proxy_id", "bad"), ("room", "private@email.test"), ("random", 1)])
def test_invalid_chat_never_requests(field, value):
    def request(*args, **kwargs):
        pytest.fail("invalid payload sent")
    with pytest.raises(ValueError):
        report_chat(request, **{**CHAT, field: value})


@pytest.mark.parametrize("field,value", [("event_id", "bad"), ("key_id", "sk-private-secret"),
    ("key_id", "Bearer secret"), ("key_id", "https://private"), ("calls", False),
    ("error_429", -1), ("error_502", 1.2), ("latency_ms", float("nan")),
    ("key_id", "slot-bbk_private"), ("error_502", 5), ("calls", 0)])
def test_invalid_usage_never_requests_or_echoes_inputs(field, value):
    def request(*args, **kwargs):
        pytest.fail("invalid payload sent")
    with pytest.raises(ValueError) as caught:
        report_ai_usage(request, **{**USAGE, field: value})
    assert "private" not in str(caught.value)


def test_invalid_proxy_code_never_requests():
    with pytest.raises(ValueError):
        report_proxy_error(lambda *a, **k: pytest.fail("invalid payload sent"), worker_id=ID, code="raw upstream body")


def test_nullable_options_boundaries_and_real_backend_schema():
    backend = pytest.importorskip("backend.hub.telemetry")
    payloads = []

    def request(method, path, **kwargs):
        payloads.append((path, kwargs["json"]))

    report_chat(request, **{**CHAT, "duration": 604800}, proxy_id=None, room=None, random=None)
    report_chat(request, **CHAT, room="9" * 128, random=False)
    report_ai_usage(request, **{**USAGE, "key_id": "9" * 80, "latency_ms": 1e20})
    report_ai_usage(request, **{**USAGE, "calls": 0, "error_429": 0, "error_502": 0, "latency_ms": 0})
    for path, payload in payloads:
        (backend.Chat if path == "/chats" else backend.AIUsage).model_validate(payload)
    assert set(payloads[0][1]) == set(CHAT)
