"""Opt-in event payloads; callers own measurements and stable event IDs."""
import math
import re

UUID = re.compile(r"[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}\Z")
LABEL = re.compile(r"[A-Za-z0-9_.-]{1,80}\Z")
ROOM = re.compile(r"[A-Za-z0-9_-]{1,128}\Z")
CODES = {"proxy_blocked", "proxy_auth", "proxy_timeout", "proxy_recovered", "other"}


def identifier(value):
    if not isinstance(value, str) or not UUID.fullmatch(value):
        raise ValueError("Invalid telemetry UUID")
    return value


def label(value):
    # A conservative format check is not a secret detector. Use operator-chosen aliases.
    if (not isinstance(value, str) or not LABEL.fullmatch(value) or
            any(part in value.lower() for part in ("bbk_", "sk_", "sk-", "bearer"))):
        raise ValueError("Telemetry label must be a nonsecret alias")
    return value


def count(value):
    if type(value) is not int or not 0 <= value <= 9007199254740991:
        raise ValueError("Invalid telemetry count")
    return value


def measurement(value, maximum=None):
    try:
        valid = (type(value) in (int, float) and value >= 0 and math.isfinite(value)
                 and (maximum is None or value <= maximum))
    except OverflowError:
        valid = False
    if not valid:
        raise ValueError("Invalid telemetry measurement")
    return value


def report_chat(request, *, event_id, worker_id, msgs_in, msgs_out, links,
                converted, duration, proxy_id=None, room=None, random=None):
    if type(converted) is not bool or (random is not None and type(random) is not bool):
        raise ValueError("Invalid telemetry boolean")
    payload = {"event_id": identifier(event_id), "worker_id": identifier(worker_id),
               "msgs_in": count(msgs_in), "msgs_out": count(msgs_out), "links": count(links),
               "converted": converted, "duration": measurement(duration, 604800)}
    if proxy_id is not None:
        payload["proxy_id"] = identifier(proxy_id)
    if room is not None:
        if not isinstance(room, str) or not ROOM.fullmatch(room):
            raise ValueError("Invalid room pseudonym")
        payload["room"] = room
    if random is not None:
        payload["random"] = random
    return request("POST", "/chats", json=payload)


def report_ai_usage(request, *, event_id, key_id, calls, error_429, error_502, latency_ms):
    count(calls)
    count(error_429)
    count(error_502)
    measurement(latency_ms)
    if error_429 + error_502 > calls or (calls == 0 and latency_ms != 0):
        raise ValueError("Invalid AI batch totals")
    return request("POST", "/ai-usage", json={
        "event_id": identifier(event_id), "key_id": label(key_id), "calls": count(calls),
        "error_429": count(error_429), "error_502": count(error_502),
        "latency_ms": measurement(latency_ms)})


def report_proxy_error(request, *, worker_id, code, proxy_id=None):
    if not isinstance(code, str) or code not in CODES:
        raise ValueError("Invalid proxy error code")
    payload = {"worker_id": identifier(worker_id), "level": "error",
               "message": "Proxy status event", "code": code}
    if proxy_id is not None:
        payload["proxy_id"] = identifier(proxy_id)
    return request("POST", "/errors", json=payload)
