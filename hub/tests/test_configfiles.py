import pytest

from hub import configfiles as cf

ENV = """# Hub connection
HUB_URL=https://hub.example.com
export API_KEY="sk-abc 123"
CAPSOLVER_API_KEY=CAP-XYZ
WORKERS=4  # inline comment
EMPTY_TOKEN=
"""


def test_env_mask_keeps_layout_and_hides_secrets():
    masked = cf.mask("env", ENV)
    assert "# Hub connection" in masked and "WORKERS=4" in masked
    assert "sk-abc" not in masked and "CAP-XYZ" not in masked
    assert "export API_KEY=********" in masked
    assert "EMPTY_TOKEN=" in masked  # empty secret stays empty, not masked


def test_env_unmask_restores_untouched_secrets_only():
    edited = cf.mask("env", ENV).replace("WORKERS=4", "WORKERS=8").replace("CAPSOLVER_API_KEY=********", "CAPSOLVER_API_KEY=NEW")
    restored = cf.unmask("env", edited, ENV)
    items = {k: v for _, k, v in cf.env_items(restored)}
    assert items["API_KEY"] == "sk-abc 123" and items["CAPSOLVER_API_KEY"] == "NEW" and items["WORKERS"] == "8"


def test_env_patch_set_add_delete():
    out = cf.patch("env", ENV, set_values={"WORKERS": "2", "NEW_FLAG": "yes", "API_KEY": cf.MASK}, delete=["HUB_URL"])
    items = {k: v for _, k, v in cf.env_items(out)}
    assert items["WORKERS"] == "2" and items["NEW_FLAG"] == "yes" and items["API_KEY"] == "sk-abc 123"
    assert "HUB_URL" not in items and "# Hub connection" in out


def test_env_rejects_garbage():
    with pytest.raises(cf.FormatError):
        cf.validate("env", "this is not env\n")


def test_json_mask_nested_and_unmask():
    text = '{"ai": {"apiKey": "bbk_secret", "presetId": "5818"}, "rate": {"perMinute": 4}, "proxy_password": "p"}'
    masked = cf.mask("json", text)
    assert "bbk_secret" not in masked and '"presetId": "5818"' in masked
    edited = masked.replace('"perMinute": 4', '"perMinute": 6')
    restored = cf.unmask("json", edited, text)
    assert '"apiKey": "bbk_secret"' in restored and '"perMinute": 6' in restored


def test_json_patch_dotted():
    out = cf.patch("json", '{"rate": {"perMinute": 4}}', set_values={"rate.perMinute": 9, "ai.presetId": "x"}, delete=["missing.key"])
    assert '"perMinute": 9' in out and '"presetId": "x"' in out


PROXIES = """# residential
http://user:pa%3Ass@1.2.3.4:8080
socks5://5.6.7.8:1080   # no auth
9.9.9.9:3128:bob:secret
"""


def test_proxies_formats_and_mask():
    entries = cf.describe("proxies", PROXIES)
    assert [e["host"] for e in entries] == ["1.2.3.4", "5.6.7.8", "9.9.9.9"]
    assert entries[0]["url"] == "http://user:********@1.2.3.4:8080"
    masked = cf.mask("proxies", PROXIES)
    assert "pa%3Ass" not in masked and "secret" not in masked and "# residential" in masked


def test_proxies_unmask_and_patch():
    masked = cf.mask("proxies", PROXIES)
    restored = cf.unmask("proxies", masked, PROXIES)
    assert [e["password"] for _, _, e in cf.proxy_lines(restored)] == ["pa:ss", "", "secret"]
    out = cf.patch("proxies", PROXIES, add_proxies=["http://new:pw@10.0.0.1:9000", "1.2.3.4:8080:user:pa:ss"],
                   remove_proxies=["socks5://5.6.7.8:1080"])
    hosts = [e["host"] for _, _, e in cf.proxy_lines(out)]
    assert hosts == ["1.2.3.4", "9.9.9.9", "10.0.0.1"]


def test_proxy_json_alpha_style():
    text = '{"proxies": ["http://u:p@1.1.1.1:80", {"host": "2.2.2.2", "port": 81, "username": "a", "password": "b"}]}'
    view = cf.describe("proxy-json", text)
    assert view[1]["url"] == "http://a:********@2.2.2.2:81"
    masked = cf.mask("proxy-json", text)
    assert '"b"' not in masked
    restored = cf.unmask("proxy-json", masked, text)
    assert cf.describe("proxy-json", restored, reveal=True)[1]["url"] == "http://a:b@2.2.2.2:81"


def test_path_rules():
    for bad in ("/etc/passwd", "../x", "a//b", "a/./b", ""):
        with pytest.raises(cf.FormatError):
            cf.check_path(bad)
    assert cf.check_path("runtime/config.json") == "runtime/config.json"
    assert cf.guess_format(".env") == "env" and cf.guess_format("proxies.txt") == "proxies"
    assert cf.guess_format("data/proxy_pool.json") == "proxy-json" and cf.guess_format("config.json") == "json"
