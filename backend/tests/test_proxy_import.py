from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4

import pytest

from hub.proxy_import import INVALID_LINE, MAX_FILE_BYTES, parse_file, parse_proxy


@pytest.mark.parametrize("text,default,url,username,password", [
    ("Example.COM:080", "http", "http://example.com:80", "", ""),
    ("host:1080:user:pass:with:colons", "socks5", "socks5://host:1080", "user", "pass:with:colons"),
    ("user:p%40ss%3Aword@HOST:443", "https", "https://host:443", "user", "p@ss:word"),
    ("SoCkS5://u%73er:p%2Bass@Host:1080", "http", "socks5://host:1080", "user", "p+ass"),
    ("HTTPS://HOST:443", "http", "https://host:443", "", ""),
    ("[2001:0DB8:0:0:0:0:0:1]:1080", "socks5", "socks5://[2001:db8::1]:1080", "", ""),
    ("[::1]:80:u:pass:more", "http", "http://[::1]:80", "u", "pass:more"),
    ("http://u:p@[::1]:80", "https", "http://[::1]:80", "u", "p"),
    ("127.0.0.1:65535", "http", "http://127.0.0.1:65535", "", ""),
    ("host:1::", "http", "http://host:1", "", ""),
    ("host:80:u:p%40", "http", "http://host:80", "u", "p%40"),
])
def test_formats_and_normalization(text, default, url, username, password):
    entry = parse_proxy(text, default, 9)
    assert (entry.line, entry.url, entry.username, entry.password) == (9, url, username, password)
    assert entry.preview(False) == {"line": 9, "url": url, "username": username,
                                    "has_password": bool(password), "duplicate": False}


@pytest.mark.parametrize("text", [
    "host", "http://host", "host:", "host:0", "host:65536", "host:-1", "host:+80", "host:８０",
    "http://host:80/", "host:80/path", "host:80?", "host:80#", "http://host:80?x=1",
    "ftp://host:80", "socks4://host:80", "file:///etc/passwd", "http://host:80:u:p",
    "2001:db8::1:1080", "[bad]:80", "[::1]80", "[fe80::1%25eth0]:80", "[127.0.0.1]:80",
    "-host:80", "host-:80", "bad_host:80", "a..b:80", "host..:80", "256.1.1.1:80", "a%2eb:80",
    "host:80 ", " host:80", "ho\tst:80", "ho\x00st:80", "host:80\x7f", "ho\u200bst:80",
    "ho\ufffdst:80", "u:%FF@host:80", "u:%00@host:80", "u:%0A@host:80", "u:%EF%BF%BD@host:80",
    "u:%zz@host:80", "u:p@ss@host:80", "user@host:80", "host:80:user", "host\\evil:80",
    "http://u:p@host:80/secret", "host:80:u:" + "p" * 4097,
])
def test_invalid_parser_is_sanitized(text):
    with pytest.raises(ValueError) as error:
        parse_proxy(text)
    assert str(error.value) == INVALID_LINE


def submit(client, admin, site_id, content, **options):
    response = client.post(f"/api/sites/{site_id}/proxies/import", headers=admin,
                           json={"content": content, **options})
    assert response.status_code == 200, response.text
    return response.json()


def test_contract_defaults_and_comments(client, admin, site):
    site_id, _ = site
    result = submit(client, admin, site_id, "\ufeff# comment\r\n\n  # comment\nproxy.example.com:8080\r\n")
    assert result == {"total": 1, "valid": 1, "duplicates": 0, "imported": 0, "can_import": True,
                      "errors": [], "entries": [{"line": 4, "url": "http://proxy.example.com:8080",
                      "username": "", "has_password": False, "duplicate": False}]}
    assert client.get(f"/api/sites/{site_id}/proxies", headers=admin).json() == []
    assert submit(client, admin, site_id, "# only comments\n")["can_import"] is False


def test_duplicates_encryption_and_reimport(client, admin, site, app):
    site_id, agent = site
    content = "HTTP://u:unique%3Asecret@HOST:080\nhost:80:u:unique:secret\nhost:80:u:different\nhttps://u:unique%3Asecret@host:80"
    preview = submit(client, admin, site_id, content)
    assert (preview["valid"], preview["duplicates"]) == (3, 1)
    assert "unique" not in str(preview) and "different" not in str(preview)
    imported = submit(client, admin, site_id, content, dry_run=False)
    assert imported["imported"] == 3 and not imported["can_import"]
    again = submit(client, admin, site_id, content, dry_run=False)
    assert (again["valid"], again["duplicates"], again["imported"]) == (0, 4, 0)
    with app.state.store.transaction() as db:
        passwords = [row[0] for row in db.execute("SELECT password FROM proxies")]
    assert all(value.startswith("gAAAA") for value in passwords)
    assert b"unique:secret" not in app.state.store.path.read_bytes()
    assert {p["password"] for p in client.get("/api/agent/config", headers=agent).json()["proxies"]} == {"unique:secret", "different"}


def test_existing_manual_normalization_and_site_scope(client, admin, site):
    site_id, _ = site
    path = f"/api/sites/{site_id}/proxies"
    assert client.post(path, headers=admin, json={"url": "HTTP://[2001:0DB8::1]:080", "username": "u", "password": "private"}).status_code == 201
    content = "u:private@[2001:db8::1]:80\nu:other@[2001:db8::1]:80"
    report = submit(client, admin, site_id, content)
    assert (report["valid"], report["duplicates"]) == (1, 1)
    other = client.post("/api/sites", headers=admin, json={"name": "Other", "url": "https://other.example"}).json()["site"]["id"]
    assert submit(client, admin, other, content)["duplicates"] == 0


def test_legacy_rows_preserved_and_count_toward_capacity(client, admin, site, monkeypatch):
    site_id, _ = site
    path = f"/api/sites/{site_id}/proxies"
    legacy = ["http://legacy.example", "https://legacy.example:443/path?old=1"]
    for url in legacy:
        assert client.post(path, headers=admin, json={"url": url, "password": "legacy-secret"}).status_code == 201
    monkeypatch.setattr("hub.app.MAX_PROXIES", 3)
    report = submit(client, admin, site_id, "new.example:80", dry_run=False)
    assert report["imported"] == 1 and report["errors"] == []
    rejected = submit(client, admin, site_id, "another.example:80", dry_run=False)
    assert rejected["imported"] == 0 and rejected["errors"][0]["line"] == 0
    rows = client.get(path, headers=admin).json()
    assert len(rows) == 3
    assert {row["url"] for row in rows} == {*legacy, "http://new.example:80"}
    assert "legacy-secret" not in str(report) + str(rejected) + str(rows)


def test_invalid_import_is_atomic_and_sanitized(client, admin, site):
    site_id, _ = site
    result = submit(client, admin, site_id, "good:80\nu:secret-password@bad:99999\n# ignored\nbad:port", dry_run=False)
    assert (result["total"], result["valid"], result["imported"], result["can_import"]) == (3, 1, 0, False)
    assert [e["line"] for e in result["errors"]] == [2, 4]
    assert "secret-password" not in str(result)
    assert client.get(f"/api/sites/{site_id}/proxies", headers=admin).json() == []


def test_file_limits():
    exact = "#" + "x" * (MAX_FILE_BYTES - 1)
    assert parse_file(exact, "http") == (0, [], [])
    for content in (exact + "x", "#" + "é" * (MAX_FILE_BYTES // 2), "#\ud800"):
        assert parse_file(content, "http")[2][0]["line"] == 0
    assert not parse_file("host:80\n" * 1000, "http")[2]
    total, entries, errors = parse_file("host:80\n" * 1001, "http")
    assert total == 1001 and not entries and errors[0]["line"] == 0


def test_limits_no_partial_and_capacity_revalidation(client, admin, site):
    site_id, _ = site
    content = "\n".join(f"host{i}:80" for i in range(1000))
    assert submit(client, admin, site_id, content)["can_import"]
    assert submit(client, admin, site_id, content, dry_run=False)["imported"] == 1000
    over = submit(client, admin, site_id, "host0:80\nextra:80", dry_run=False)
    assert over["imported"] == 0 and over["errors"][0]["line"] == 0
    assert len(client.get(f"/api/sites/{site_id}/proxies", headers=admin).json()) == 1000
    assert submit(client, admin, site_id, "host0:80", dry_run=False)["errors"] == []


def test_concurrent_import_rechecks_duplicates(client, admin, site):
    site_id, _ = site
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: submit(client, admin, site_id, "host:80:u:password", dry_run=False), range(2)))
    assert sorted(r["imported"] for r in results) == [0, 1]


def test_concurrent_capacity_and_no_network(client, admin, site, monkeypatch):
    import httpx

    def no_network(*args, **kwargs):
        pytest.fail("Import must not fetch or contact proxies")

    monkeypatch.setattr(httpx.HTTPTransport, "handle_request", no_network)
    monkeypatch.setattr(httpx.AsyncHTTPTransport, "handle_async_request", no_network)
    site_id, _ = site
    assert submit(client, admin, site_id, "\n".join(f"host{i}:80" for i in range(999)), dry_run=False)["imported"] == 999
    assert submit(client, admin, site_id, "extra:80")["can_import"]
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda i: submit(client, admin, site_id, f"extra{i}:80", dry_run=False), range(2)))
    assert sorted(r["imported"] for r in results) == [0, 1]
    assert sum(bool(r["errors"]) for r in results) == 1


def test_auth_and_sanitized_validation(client, admin, site):
    site_id, agent = site
    path = f"/api/sites/{site_id}/proxies/import"
    for headers in ({}, agent):
        assert client.post(path, headers=headers, json={"content": "host:80"}).status_code == 401
    assert client.post(f"/api/sites/{uuid4()}/proxies/import", headers=admin, json={"content": "host:80"}).status_code == 404
    for body in ({}, {"content": 12}, {"content": "private", "proxy_type": "private"},
                 {"content": "private", "dry_run": "private"}, {"content": "private", "private": "private"}):
        response = client.post(path, headers=admin, json=body)
        assert response.status_code == 422
        assert "private" not in response.text
