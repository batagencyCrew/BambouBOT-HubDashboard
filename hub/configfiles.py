"""Text-preserving handlers for the configuration files a script keeps on its VPS.

The hub stores each file's exact text (encrypted) so comments and formatting in
``.env`` and ``proxies.txt`` survive round trips. Handlers provide:

* ``validate``   - reject malformed content before it reaches a VPS
* ``mask``       - the same text with secret values replaced by ``MASK``
* ``unmask``     - restore secrets a masked edit left as ``MASK``
* ``patch``      - structured edits (set/delete keys, add/remove proxies)
* ``describe``   - a parsed, masked view for tables in the dashboard and bots
* ``diff_keys``  - names (never values) of what changed, for history/audit

Nothing here touches the filesystem or the network.
"""

from __future__ import annotations

import json
import re
from urllib.parse import quote, unquote, urlsplit

FORMATS = ("json", "env", "proxies", "proxy-json", "text")
MASK = "********"
MAX_CONTENT = 1024 * 1024

_ENV_LINE = re.compile(r"^(?P<prefix>\s*(?:export\s+)?)(?P<key>[A-Za-z_][A-Za-z0-9_.]*)(?P<eq>\s*=\s*)(?P<value>.*)$")
_SECRET_HINT = re.compile(r"(?i)(secret|token|passw|api[_-]?key|apikey|private|credential|cookie|session|auth|bearer|dsn)")
_PROXY_SCHEMES = {"http", "https", "socks5", "socks5h", "socks4"}


class FormatError(ValueError):
    pass


def looks_secret(key: str) -> bool:
    return bool(_SECRET_HINT.search(key))


def guess_format(path: str) -> str:
    name = path.rsplit("/", 1)[-1].lower()
    if name == ".env" or name.endswith(".env") or name.startswith(".env."):
        return "env"
    if "prox" in name and name.endswith(".json"):
        return "proxy-json"
    if name.endswith(".json"):
        return "json"
    if "prox" in name and name.endswith((".txt", ".list")):
        return "proxies"
    return "text"


def check_path(path: str) -> str:
    """Relative path inside the script root; no traversal, no hidden dirs except .env."""
    if not path or len(path) > 300 or path.startswith("/") or "\\" in path or "\x00" in path:
        raise FormatError("Path must be relative to the script root")
    parts = path.split("/")
    if any(p in ("", ".", "..") for p in parts):
        raise FormatError("Path must not contain empty, '.' or '..' segments")
    return path


# ---------------------------------------------------------------------------
# env
# ---------------------------------------------------------------------------

def _env_unquote(value: str) -> str:
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
        inner = value[1:-1]
        return inner.replace('\\"', '"').replace("\\\\", "\\") if value[0] == '"' else inner
    # Unquoted values may carry a trailing comment.
    return re.split(r"\s+#", value, maxsplit=1)[0].strip()


def _env_quote(value: str) -> str:
    if value == "" or re.search(r"[\s#\"'\\$`]", value):
        return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'
    return value


def env_items(text: str) -> list[tuple[int, str, str]]:
    items = []
    for number, line in enumerate(text.splitlines(), 1):
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        match = _ENV_LINE.match(line)
        if not match:
            raise FormatError(f".env line {number}: expected KEY=value")
        items.append((number, match["key"], _env_unquote(match["value"])))
    return items


def _env_replace(text: str, transform) -> str:
    out = []
    for line in text.splitlines(keepends=True):
        body = line.rstrip("\r\n")
        ending = line[len(body):]
        match = _ENV_LINE.match(body) if body.strip() and not body.strip().startswith("#") else None
        if match:
            new = transform(match["key"], _env_unquote(match["value"]))
            if new is not None:
                body = f"{match['prefix']}{match['key']}{match['eq']}{_env_quote(new)}"
        out.append(body + ending)
    return "".join(out)


# ---------------------------------------------------------------------------
# json
# ---------------------------------------------------------------------------

def _json_load(text: str):
    try:
        return json.loads(text)
    except json.JSONDecodeError as exc:
        raise FormatError(f"Invalid JSON at line {exc.lineno}, column {exc.colno}") from None


def _json_walk_mask(doc, secrets: set[str], path=""):
    if isinstance(doc, dict):
        out = {}
        for key, value in doc.items():
            dotted = f"{path}.{key}" if path else key
            if (key in secrets or dotted in secrets or looks_secret(key)) and isinstance(value, (str, int, float)) and value != "":
                out[key] = MASK
            else:
                out[key] = _json_walk_mask(value, secrets, dotted)
        return out
    if isinstance(doc, list):
        return [_json_walk_mask(v, secrets, path) for v in doc]
    return doc


def _json_walk_unmask(new, old):
    if new == MASK:
        return old if old is not None else ""
    if isinstance(new, dict):
        old = old if isinstance(old, dict) else {}
        return {k: _json_walk_unmask(v, old.get(k)) for k, v in new.items()}
    if isinstance(new, list):
        old = old if isinstance(old, list) else []
        return [_json_walk_unmask(v, old[i] if i < len(old) else None) for i, v in enumerate(new)]
    return new


def _json_paths(doc, path=""):
    if isinstance(doc, dict):
        for key, value in doc.items():
            dotted = f"{path}.{key}" if path else key
            yield dotted, value
            if isinstance(value, dict):
                yield from _json_paths(value, dotted)


def _json_set(doc: dict, dotted: str, value):
    parts = dotted.split(".")
    node = doc
    for part in parts[:-1]:
        if not isinstance(node.get(part), dict):
            node[part] = {}
        node = node[part]
    node[parts[-1]] = value


def _json_delete(doc: dict, dotted: str):
    parts = dotted.split(".")
    node = doc
    for part in parts[:-1]:
        node = node.get(part)
        if not isinstance(node, dict):
            return
    node.pop(parts[-1], None)


# ---------------------------------------------------------------------------
# proxies
# ---------------------------------------------------------------------------

def parse_proxy(text: str) -> dict:
    """Accept scheme://user:pass@host:port, host:port, host:port:user:pass, user:pass@host:port."""
    raw = text.strip()
    if any(c.isspace() for c in raw):
        raise FormatError("Proxy must not contain whitespace")
    if "://" not in raw:
        pieces = raw.split(":", 3)  # host:port:user:pass — the password may contain ':'
        if "@" in raw:
            raw = "http://" + raw
        elif len(pieces) == 4:
            host, port, user, password = pieces
            raw = f"http://{quote(user, safe='')}:{quote(password, safe='')}@{host}:{port}"
        elif len(pieces) == 2:
            raw = "http://" + raw
        else:
            raise FormatError("Unrecognised proxy format")
    parts = urlsplit(raw)
    if parts.scheme.lower() not in _PROXY_SCHEMES:
        raise FormatError("Unsupported proxy scheme")
    if not parts.hostname:
        raise FormatError("Proxy is missing a host")
    try:
        port = parts.port
    except ValueError:
        raise FormatError("Proxy port is invalid") from None
    if not port:
        raise FormatError("Proxy must include a port")
    return {"scheme": parts.scheme.lower(), "host": parts.hostname, "port": port,
            "username": unquote(parts.username or ""), "password": unquote(parts.password or "")}


def proxy_url(entry: dict, masked: bool = False) -> str:
    auth = ""
    if entry["username"] or entry["password"]:
        password = (MASK if masked else quote(entry["password"], safe="")) if entry["password"] else ""
        auth = quote(entry["username"], safe="") + (f":{password}" if entry["password"] else "") + "@"
    host = f"[{entry['host']}]" if ":" in entry["host"] else entry["host"]
    return f"{entry['scheme']}://{auth}{host}:{entry['port']}"


def proxy_key(entry: dict) -> str:
    import hashlib
    return hashlib.sha256(f"{entry['scheme']}|{entry['host'].lower()}|{entry['port']}|{entry['username']}".encode()).hexdigest()[:16]


def proxy_lines(text: str) -> list[tuple[int, str, dict]]:
    out = []
    for number, line in enumerate(text.splitlines(), 1):
        body = line.split("#", 1)[0].strip()
        if not body:
            continue
        try:
            out.append((number, line, parse_proxy(body)))
        except FormatError as exc:
            raise FormatError(f"Line {number}: {exc}") from None
    return out


def _mask_proxy_line(line: str, entry: dict) -> str:
    if not entry["password"]:
        return line
    body, sep, comment = line.partition("#")
    lead = body[: len(body) - len(body.lstrip())]
    trail = body[len(body.rstrip()):]
    original = body.strip()
    # Preserve the user's chosen notation where possible.
    if "://" in original or "@" in original:
        masked = re.sub(r"(:)([^:@/]*)(@)", lambda m: m.group(1) + MASK + m.group(3), original, count=1)
    else:
        pieces = original.split(":", 3)
        pieces[3] = MASK
        masked = ":".join(pieces)
    return lead + masked + trail + sep + comment


def _proxy_json_items(text: str):
    doc = _json_load(text)
    items = doc.get("proxies") if isinstance(doc, dict) else doc
    if not isinstance(items, list):
        raise FormatError("Proxy JSON must be a list or contain a 'proxies' list")
    return doc, items


def _proxy_json_entry(item) -> dict:
    if isinstance(item, str):
        return parse_proxy(item)
    if isinstance(item, dict):
        if "url" in item:
            entry = parse_proxy(str(item["url"]))
            if item.get("username"):
                entry["username"] = str(item["username"])
            if item.get("password"):
                entry["password"] = str(item["password"])
            return entry
        if "host" in item and "port" in item:
            return {"scheme": str(item.get("scheme", item.get("protocol", "http"))).lower(), "host": str(item["host"]),
                    "port": int(item["port"]), "username": str(item.get("username", item.get("user", "")) or ""),
                    "password": str(item.get("password", item.get("pass", "")) or "")}
    raise FormatError("Proxy entries must be URLs or objects with url/host+port")


def _proxy_json_mask(item):
    if isinstance(item, str):
        entry = parse_proxy(item)
        return proxy_url(entry, masked=True) if entry["password"] else item
    if isinstance(item, dict):
        out = dict(item)
        for key in ("password", "pass"):
            if out.get(key):
                out[key] = MASK
        if isinstance(out.get("url"), str):
            entry = parse_proxy(out["url"])
            if entry["password"]:
                out["url"] = proxy_url(entry, masked=True)
        return out
    return item


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def validate(fmt: str, text: str) -> None:
    if fmt not in FORMATS:
        raise FormatError(f"Unknown format {fmt}")
    if len(text.encode()) > MAX_CONTENT:
        raise FormatError("File larger than 1 MiB")
    if "\x00" in text:
        raise FormatError("File must be text")
    if fmt == "env":
        env_items(text)
    elif fmt == "json":
        _json_load(text)
    elif fmt == "proxies":
        proxy_lines(text)
    elif fmt == "proxy-json":
        _, items = _proxy_json_items(text)
        for item in items:
            _proxy_json_entry(item)


def mask(fmt: str, text: str, secret_keys: list[str] | None = None) -> str:
    secrets = set(secret_keys or [])
    if fmt == "env":
        return _env_replace(text, lambda k, v: MASK if v and (k in secrets or looks_secret(k)) else None)
    if fmt == "json":
        return json.dumps(_json_walk_mask(_json_load(text), secrets), indent=2) + "\n"
    if fmt == "proxies":
        lines = text.splitlines(keepends=True)
        parsed = {n: e for n, _, e in proxy_lines(text)}
        out = []
        for number, line in enumerate(lines, 1):
            ending = line[len(line.rstrip("\r\n")):]
            body = line.rstrip("\r\n")
            out.append((_mask_proxy_line(body, parsed[number]) if number in parsed else body) + ending)
        return "".join(out)
    if fmt == "proxy-json":
        doc, items = _proxy_json_items(text)
        masked = [_proxy_json_mask(i) for i in items]
        doc = {**doc, "proxies": masked} if isinstance(doc, dict) else masked
        return json.dumps(doc, indent=2) + "\n"
    return text


def unmask(fmt: str, new_text: str, old_text: str | None, secret_keys: list[str] | None = None) -> str:
    """Replace MASK placeholders in an edited document with the previous values."""
    if MASK not in new_text or not old_text:
        if MASK in new_text:
            raise FormatError("Masked placeholder present but no stored value to restore")
        return new_text
    if fmt == "env":
        old = {k: v for _, k, v in env_items(old_text)}
        def restore(key, value):
            if value == MASK:
                if key not in old:
                    raise FormatError(f"{key} is masked but has no stored value")
                return old[key]
            return None
        return _env_replace(new_text, restore)
    if fmt == "json":
        return json.dumps(_json_walk_unmask(_json_load(new_text), _json_load(old_text)), indent=2) + "\n"
    if fmt in ("proxies", "proxy-json"):
        old_entries = ([e for _, _, e in proxy_lines(old_text)] if fmt == "proxies"
                       else [_proxy_json_entry(i) for i in _proxy_json_items(old_text)[1]])
        by_identity = {(e["scheme"], e["host"].lower(), e["port"], e["username"]): e["password"] for e in old_entries}
        def find(entry):
            key = (entry["scheme"], entry["host"].lower(), entry["port"], entry["username"])
            if key not in by_identity:
                raise FormatError(f"Masked password for {entry['host']}:{entry['port']} has no stored value")
            return by_identity[key]
        if fmt == "proxies":
            out = []
            for line in new_text.splitlines(keepends=True):
                body = line.split("#", 1)[0].strip()
                if body and MASK in body:
                    entry = parse_proxy(body.replace(MASK, "x"))
                    entry["password"] = find(entry)
                    ending = line[len(line.rstrip("\r\n")):]
                    comment = line.rstrip("\r\n").partition("#")
                    line = proxy_url(entry) + ((" #" + comment[2]) if comment[1] else "") + ending
                out.append(line)
            return "".join(out)
        doc, items = _proxy_json_items(new_text)
        restored = []
        for item in items:
            if isinstance(item, str) and MASK in item:
                entry = parse_proxy(item.replace(MASK, "x"))
                entry["password"] = find(entry)
                restored.append(proxy_url(entry))
            elif isinstance(item, dict) and MASK in json.dumps(item):
                entry = _proxy_json_entry({**item, **({"url": item["url"].replace(MASK, "x")} if isinstance(item.get("url"), str) else {}),
                                           **({"password": "x"} if item.get("password") == MASK else {})})
                password = find(entry)
                fixed = dict(item)
                if fixed.get("password") == MASK:
                    fixed["password"] = password
                if fixed.get("pass") == MASK:
                    fixed["pass"] = password
                if isinstance(fixed.get("url"), str) and MASK in fixed["url"]:
                    fixed["url"] = proxy_url({**entry, "password": password})
                restored.append(fixed)
            else:
                restored.append(item)
        doc = {**doc, "proxies": restored} if isinstance(doc, dict) else restored
        return json.dumps(doc, indent=2) + "\n"
    raise FormatError("Plain text files cannot contain masked values")


def patch(fmt: str, text: str, *, set_values: dict | None = None, delete: list[str] | None = None,
          add_proxies: list[str] | None = None, remove_proxies: list[str] | None = None) -> str:
    """Structured edit. ``MASK`` values in set_values keep the existing value."""
    set_values = set_values or {}
    delete = delete or []
    if fmt == "env":
        current = {k for _, k, _ in env_items(text)}
        updated = _env_replace(text, lambda k, v: None if set_values.get(k, MASK) == MASK else str(set_values[k]))
        lines = [line for line in updated.splitlines(keepends=True)
                 if not ((m := _ENV_LINE.match(line.rstrip("\r\n"))) and m["key"] in delete)]
        updated = "".join(lines)
        additions = [k for k in set_values if k not in current and set_values[k] != MASK]
        if additions:
            if updated and not updated.endswith("\n"):
                updated += "\n"
            updated += "".join(f"{k}={_env_quote(str(set_values[k]))}\n" for k in additions)
        return updated
    if fmt == "json":
        doc = _json_load(text) if text.strip() else {}
        if not isinstance(doc, dict):
            raise FormatError("Structured edits require a JSON object")
        for key in delete:
            _json_delete(doc, key)
        for key, value in set_values.items():
            if value != MASK:
                _json_set(doc, key, value)
        return json.dumps(doc, indent=2) + "\n"
    if fmt in ("proxies", "proxy-json"):
        remove = set()
        for item in remove_proxies or []:
            entry = parse_proxy(item.replace(MASK, "x")) if "://" in item or ":" in item else None
            remove.add(proxy_key(entry) if entry else item)
        added = [parse_proxy(p) for p in (add_proxies or [])]
        if fmt == "proxies":
            kept, seen = [], set()
            for line in text.splitlines(keepends=True):
                body = line.split("#", 1)[0].strip()
                if body:
                    entry = parse_proxy(body)
                    if proxy_key(entry) in remove:
                        continue
                    seen.add(proxy_key(entry))
                kept.append(line)
            result = "".join(kept)
            if result and not result.endswith("\n"):
                result += "\n"
            for entry in added:
                if proxy_key(entry) not in seen:
                    result += proxy_url(entry) + "\n"
                    seen.add(proxy_key(entry))
            return result
        doc, items = _proxy_json_items(text) if text.strip() else ({"proxies": []}, [])
        kept = [i for i in items if proxy_key(_proxy_json_entry(i)) not in remove]
        seen = {proxy_key(_proxy_json_entry(i)) for i in kept}
        for entry in added:
            if proxy_key(entry) not in seen:
                kept.append(proxy_url(entry))
                seen.add(proxy_key(entry))
        doc = {**doc, "proxies": kept} if isinstance(doc, dict) else kept
        return json.dumps(doc, indent=2) + "\n"
    raise FormatError("Structured edits are not supported for plain text; replace the full content")


def describe(fmt: str, text: str, secret_keys: list[str] | None = None, reveal: bool = False):
    secrets = set(secret_keys or [])
    if fmt == "env":
        return [{"key": k, "value": v if reveal or not (v and (k in secrets or looks_secret(k))) else MASK,
                 "secret": k in secrets or looks_secret(k), "line": n} for n, k, v in env_items(text)]
    if fmt == "json":
        doc = _json_load(text)
        return doc if reveal else _json_walk_mask(doc, secrets)
    if fmt in ("proxies", "proxy-json"):
        entries = ([(n, e) for n, _, e in proxy_lines(text)] if fmt == "proxies"
                   else list(enumerate((_proxy_json_entry(i) for i in _proxy_json_items(text)[1]), 1)))
        return [{"line": n, "key": proxy_key(e), "url": proxy_url(e, masked=not reveal), "scheme": e["scheme"],
                 "host": e["host"], "port": e["port"], "username": e["username"],
                 "has_password": bool(e["password"])} for n, e in entries]
    return None


def diff_keys(fmt: str, old: str | None, new: str) -> dict:
    """Names of changed keys/proxies — never values — for history and audit."""
    try:
        if fmt == "env":
            a = {k: v for _, k, v in env_items(old or "")}
            b = {k: v for _, k, v in env_items(new)}
        elif fmt == "json":
            a = dict(_json_paths(_json_load(old))) if old else {}
            b = dict(_json_paths(_json_load(new)))
            a = {k: json.dumps(v, sort_keys=True) for k, v in a.items() if not isinstance(v, dict)}
            b = {k: json.dumps(v, sort_keys=True) for k, v in b.items() if not isinstance(v, dict)}
        elif fmt == "proxies":
            a = {proxy_key(e): proxy_url(e) for _, _, e in proxy_lines(old or "")}
            b = {proxy_key(e): proxy_url(e) for _, _, e in proxy_lines(new)}
            return {"added": len(set(b) - set(a)), "removed": len(set(a) - set(b)), "total": len(b)}
        elif fmt == "proxy-json":
            a = {proxy_key(_proxy_json_entry(i)) for i in (_proxy_json_items(old)[1] if old else [])}
            b = {proxy_key(_proxy_json_entry(i)) for i in _proxy_json_items(new)[1]}
            return {"added": len(b - a), "removed": len(a - b), "total": len(b)}
        else:
            return {"bytes": len(new.encode())}
    except FormatError:
        return {}
    return {"added": sorted(set(b) - set(a))[:100], "removed": sorted(set(a) - set(b))[:100],
            "changed": sorted(k for k in set(a) & set(b) if a[k] != b[k])[:100]}
