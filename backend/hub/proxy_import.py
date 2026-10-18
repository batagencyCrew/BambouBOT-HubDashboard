"""Pure, bounded proxy-file parsing. Never resolves or connects to hosts."""

from dataclasses import dataclass, field
from ipaddress import IPv4Address, IPv6Address
import re
import unicodedata
from urllib.parse import unquote


MAX_FILE_BYTES = 512 * 1024
MAX_FILE_ENTRIES = 1000
SCHEMES = {"http", "https", "socks5"}
INVALID_LINE = "Invalid proxy: use a supported scheme, valid host and explicit port (1-65535)"


def unsafe(value: str) -> bool:
    return any(c.isspace() or unicodedata.category(c).startswith("C") or c == "\ufffd" for c in value)


def unsafe_credential(value: str) -> bool:
    # Raw whitespace is rejected before URL parsing, but percent-encoded spaces
    # are legitimate credential characters and must round-trip from the hub.
    return any(unicodedata.category(c).startswith("C") or c == "\ufffd" for c in value)


@dataclass(frozen=True)
class ProxyEntry:
    line: int
    url: str
    username: str = ""
    password: str = field(default="", repr=False)

    @property
    def identity(self):
        return self.url, self.username, self.password

    def preview(self, duplicate: bool):
        return {"line": self.line, "url": self.url, "username": self.username,
                "has_password": bool(self.password), "duplicate": duplicate}


def decode_credential(value: str) -> str:
    if re.search(r"%(?![0-9a-fA-F]{2})", value):
        raise ValueError(INVALID_LINE)
    return unquote(value, encoding="utf-8", errors="strict")


def normalize_host(host: str) -> str:
    if host.startswith("[") and host.endswith("]"):
        if "%" in host:
            raise ValueError(INVALID_LINE)
        return f"[{IPv6Address(host[1:-1]).compressed}]"
    if not host or any(c in host for c in ":[]%"):
        raise ValueError(INVALID_LINE)
    host = host.encode("idna").decode("ascii").lower().removesuffix(".")
    if len(host) > 253 or not host:
        raise ValueError(INVALID_LINE)
    if re.fullmatch(r"[0-9.]+", host):
        return str(IPv4Address(host))
    if any(not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", label) for label in host.split(".")):
        raise ValueError(INVALID_LINE)
    return host


def parse_proxy(value: str, default_type: str = "http", line: int = 0) -> ProxyEntry:
    """Parse without allowing URL parsers to silently discard controls or paths."""
    try:
        if not value or unsafe(value) or "\\" in value:
            raise ValueError(INVALID_LINE)
        scheme, authority = default_type, value
        explicit = "://" in value
        if explicit:
            scheme, authority = value.split("://", 1)
            scheme = scheme.lower()
        if scheme not in SCHEMES or any(c in authority for c in "/?#\\"):
            raise ValueError(INVALID_LINE)
        username = password = ""
        if "@" in authority:
            if authority.count("@") != 1:
                raise ValueError(INVALID_LINE)
            credentials, authority = authority.split("@")
            if ":" not in credentials:
                raise ValueError(INVALID_LINE)
            username, password = (decode_credential(v) for v in credentials.split(":", 1))
            suffix = ""
        else:
            suffix = None
        if authority.startswith("["):
            match = re.fullmatch(r"(\[[^\]]+\]):([0-9]+)(.*)", authority)
        else:
            match = re.fullmatch(r"([^:]+):([0-9]+)(.*)", authority)
        if match is None:
            raise ValueError(INVALID_LINE)
        host, port, remainder = match.groups()
        if remainder:
            if explicit or suffix is not None or not remainder.startswith(":") or ":" not in remainder[1:]:
                raise ValueError(INVALID_LINE)
            username, password = remainder[1:].split(":", 1)
        if not 1 <= int(port) <= 65535:
            raise ValueError(INVALID_LINE)
        host = normalize_host(host)
        url = f"{scheme}://{host}:{int(port)}"
        if unsafe_credential(username) or unsafe_credential(password) or len(username) > 512 or len(password) > 4096 or len(url) > 2048:
            raise ValueError(INVALID_LINE)
        return ProxyEntry(line, url, username, password)
    except (ValueError, UnicodeError):
        raise ValueError(INVALID_LINE) from None


def parse_file(content: str, default_type: str):
    """Return total, parsed entries and sanitized errors (including file-level errors)."""
    lines = content.removeprefix("\ufeff").split("\n")
    candidates = [(n, text.removesuffix("\r")) for n, text in enumerate(lines, 1)
                  if text.strip() and not text.lstrip().startswith("#")]
    total = len(candidates)
    try:
        size = len(content.encode("utf-8"))
    except UnicodeError:
        return total, [], [{"line": 0, "message": "File must contain valid UTF-8 text"}]
    if size > MAX_FILE_BYTES:
        return total, [], [{"line": 0, "message": "File exceeds 512 KiB limit"}]
    if total > MAX_FILE_ENTRIES:
        return total, [], [{"line": 0, "message": "File exceeds 1000 entry limit"}]
    entries, errors = [], []
    for number, text in candidates:
        try:
            entries.append(parse_proxy(text, default_type, number))
        except ValueError:
            errors.append({"line": number, "message": INVALID_LINE})
    return total, entries, errors
