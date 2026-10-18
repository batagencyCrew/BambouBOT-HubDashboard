"""Optional real-browser checks. Build frontend first. Uses isolated temporary data."""
import os
from pathlib import Path
import re
import socket
import subprocess
import sys
import tempfile
import time
from uuid import uuid4

import requests
from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
QA = ROOT / ".qa"


def main():
    QA.mkdir(exist_ok=True)
    screenshots = QA / "screenshots"
    screenshots.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="browser-", dir=QA) as directory:
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        origin = f"http://127.0.0.1:{port}"
        env = dict(os.environ, HUB_ADMIN_PASSWORD="browser-smoke-only-password", HUB_DATA_DIR=directory + "/data")
        cloud = Path(directory) / "cloud"
        cloud.mkdir()
        cloud_config = Path(directory) / "rclone.conf"
        cloud_config.write_text(f"[browser]\ntype = alias\nremote = {cloud}\n")
        cloud_config.chmod(0o600)
        env["HUB_RCLONE_CONFIG"] = str(cloud_config)
        env["HUB_BACKUP_WORKER_ENABLED"] = "true"
        env.pop("HUB_ENCRYPTION_KEY", None)
        with open(directory + "/server.log", "w") as log:
            server = subprocess.Popen([sys.executable, "-m", "uvicorn", "backend.app:app", "--host", "127.0.0.1",
                                       "--port", str(port)], cwd=ROOT, env=env, stdout=log, stderr=log)
            try:
                deadline = time.monotonic() + 15
                while True:
                    try:
                        if requests.get(origin + "/api/health", timeout=1).ok:
                            break
                    except requests.RequestException:
                        pass
                    if time.monotonic() >= deadline:
                        raise RuntimeError("Test hub did not start")
                    time.sleep(0.1)
                with sync_playwright() as playwright:
                    launch = {"headless": True}
                    if os.environ.get("BROWSER_EXECUTABLE"):
                        launch["executable_path"] = os.environ["BROWSER_EXECUTABLE"]
                    if os.geteuid() == 0:
                        launch["args"] = ["--no-sandbox"]
                    browser = playwright.chromium.launch(**launch)
                    page = browser.new_page(viewport={"width": 1440, "height": 1000}, device_scale_factor=1)
                    page.emulate_media(reduced_motion="reduce")
                    errors = []
                    page.on("pageerror", lambda error: errors.append(str(error)))
                    preset_requests = []
                    archive_production = False

                    def mock_presets(route):
                        payload = route.request.post_data_json
                        preset_requests.append(payload)
                        if payload.get("ai_api_key") == "invalid-test-key":
                            route.fulfill(status=400, json={"detail": "AI API key was rejected by preset provider"})
                        else:
                            route.fulfill(json={"presets": [
                                {"id": "production-preset", "name": "Production preset", "archived": archive_production},
                                {"id": "secondary", "name": "Secondary preset", "archived": False},
                                {"id": "archived", "name": "Archived preset", "archived": True},
                            ]})

                    # UI tests are deterministic and must never call the provider with fake keys.
                    page.route("**/api/sites/*/presets", mock_presets)
                    page.goto(origin)
                    page.get_by_label("Admin password").fill(env["HUB_ADMIN_PASSWORD"])
                    page.screenshot(path=str(screenshots / "login.png"))
                    page.get_by_role("button", name="Sign in to workspace").click()
                    expect(page.get_by_role("heading", name="Your automation, at a glance.")).to_be_visible()
                    page.get_by_role("button", name="Add site", exact=True).last.click()
                    dialog = page.get_by_role("dialog")
                    dialog.get_by_label("Site name").fill("Production storefront")
                    dialog.get_by_label("Site URL").fill("https://example.com")
                    dialog.get_by_label("Description").fill("Authorized site automation on VPS-01")
                    dialog.get_by_role("button", name="Create site").click()
                    expect(page.get_by_role("heading", name="Your agent token")).to_be_visible()
                    agent_token = page.get_by_label("Agent token", exact=True).input_value()
                    page.get_by_role("button", name=re.compile("saved my token")).click()
                    admin_token = page.evaluate("sessionStorage.getItem('bambou.access_token')")
                    session = requests.Session()
                    session.headers["Authorization"] = "Bearer " + admin_token

                    def api(method, path, **kwargs):
                        response = session.request(method, origin + "/api" + path, timeout=5, **kwargs)
                        response.raise_for_status()
                        return response.json() if response.content else None

                    site_id = api("GET", "/sites")[0]["id"]
                    base = f"/sites/{site_id}"
                    agent_headers = {"Authorization": "Bearer " + agent_token}

                    def agent_api(method, path, **kwargs):
                        response = requests.request(method, origin + "/api/agent" + path,
                                                    headers=agent_headers, timeout=5, **kwargs)
                        response.raise_for_status()
                        return response.json()

                    page.locator(".site-card").click()
                    page.get_by_role("tab", name="Configuration").click()
                    page.get_by_label("Number of workers").fill("2")
                    page.get_by_label("AI API key", exact=True).fill("browser-test-ai-secret")
                    page.get_by_label("Captcha API key", exact=True).fill("browser-test-captcha-secret")
                    page.get_by_role("button", name="Load presets", exact=True).click()
                    expect(page.get_by_role("option", name="Production preset (production-preset)", exact=True)).to_be_attached()
                    expect(page.get_by_role("option", name="Archived preset (archived)", exact=True)).to_be_disabled()
                    assert preset_requests[-1] == {"ai_api_key": "browser-test-ai-secret"}
                    assert api("GET", base + "/config")["has_ai_api_key"] is False
                    page.get_by_label("AI preset", exact=True).select_option("production-preset")
                    page.get_by_role("button", name="Save configuration").click()
                    expect(page.get_by_text("Configuration saved.", exact=False)).to_be_visible()
                    assert agent_api("GET", "/config")["ai_api_key"] == "browser-test-ai-secret"
                    expect(page.get_by_label("AI API key", exact=True)).to_have_value("")
                    expect(page.get_by_role("option", name="Production preset (production-preset)", exact=True)).to_be_attached()
                    assert preset_requests[-1] == {}
                    archive_production = True
                    page.get_by_role("button", name="Refresh presets", exact=True).click()
                    expect(page.locator('optgroup option[value="production-preset"]')).to_be_enabled()
                    page.get_by_label("AI preset", exact=True).select_option("secondary")
                    expect(page.locator('optgroup option[value="production-preset"]')).to_be_enabled()
                    page.get_by_label("AI preset", exact=True).select_option("production-preset")
                    archive_production = False
                    page.get_by_label("AI API key", exact=True).fill("invalid-test-key")
                    page.get_by_role("button", name="Load presets", exact=True).click()
                    expect(page.get_by_text("Unable to load presets:", exact=False)).to_be_visible()
                    expect(page.get_by_label("AI preset", exact=True)).to_have_value("production-preset")
                    page.get_by_label("AI API key", exact=True).fill("   ")
                    expect(page.get_by_role("button", name="Load presets", exact=True)).to_be_disabled()
                    page.get_by_role("button", name="Save configuration").click()
                    expect(page.get_by_text("API keys cannot contain only whitespace.", exact=False)).to_be_visible()
                    assert agent_api("GET", "/config")["ai_api_key"] == "browser-test-ai-secret"
                    page.get_by_label("AI API key", exact=True).fill("")
                    page.get_by_label("Number of workers").fill("3")
                    page.get_by_role("button", name="Save configuration").click()
                    expect(page.get_by_text("Configuration saved.", exact=False)).to_be_visible()
                    assert agent_api("GET", "/config")["ai_api_key"] == "browser-test-ai-secret"
                    page.get_by_role("button", name="Clear key", exact=True).first.click()
                    page.get_by_role("button", name="Save configuration").click()
                    expect(page.get_by_text("Configuration saved.", exact=False)).to_be_visible()
                    assert agent_api("GET", "/config")["ai_api_key"] == ""

                    page.get_by_role("tab", name="Proxies").click()
                    page.get_by_role("button", name="Add proxy", exact=True).click()
                    dialog = page.get_by_role("dialog")
                    dialog.get_by_label("Proxy type", exact=True).select_option("socks5")
                    dialog.get_by_label("Host:port", exact=True).fill("socks5://proxy.example.com:1080")
                    dialog.get_by_role("button", name="Add proxy", exact=True).click()
                    expect(dialog.get_by_role("alert")).to_be_visible()
                    assert api("GET", base + "/proxies") == []
                    dialog.get_by_label("Host:port", exact=True).fill("proxy.example.com:1080")
                    dialog.get_by_label("Username").fill("proxy-user")
                    dialog.get_by_label("Password").fill("browser-test-proxy-secret")
                    dialog.get_by_role("button", name="Add proxy", exact=True).click()
                    expect(page.get_by_text("socks5://proxy.example.com:1080", exact=True)).to_be_visible()
                    assert "browser-test-proxy-secret" not in page.locator("body").inner_text()

                    page.get_by_role("button", name="Import proxies", exact=True).click()
                    dialog = page.get_by_role("dialog")
                    dialog.get_by_label("Default proxy type", exact=True).select_option("https")
                    dialog.get_by_label("Proxy file", exact=True).set_input_files({
                        "name": "invalid-proxies.txt", "mimeType": "text/plain",
                        "buffer": b"new-proxy.example.com:8080:import-user:import-password\ninvalid-line\n",
                    })
                    dialog.get_by_role("button", name="Preview import", exact=True).click()
                    expect(dialog.get_by_role("alert")).to_contain_text("Line 2")
                    expect(dialog.get_by_role("button", name="Import proxies", exact=True)).to_be_disabled()
                    assert len(api("GET", base + "/proxies")) == 1
                    dialog.get_by_label("Proxy file", exact=True).set_input_files({
                        "name": "proxies.txt", "mimeType": "text/plain",
                        "buffer": (
                            "# Mixed protocols and duplicate entries\n"
                            "new-proxy.example.com:8080:import-user:import-password\n"
                            "new-proxy.example.com:8080:import-user:import-password\n"
                            "socks5://proxy-user:browser-test-proxy-secret@proxy.example.com:1080\n"
                            "http://other-proxy.example.com:80\n"
                        ).encode(),
                    })
                    expect(dialog.get_by_role("button", name="Import proxies", exact=True)).to_be_disabled()
                    dialog.get_by_role("button", name="Preview import", exact=True).click()
                    expect(dialog.get_by_text("https://new-proxy.example.com:8080", exact=True).first).to_be_visible()
                    expect(dialog.get_by_text("http://other-proxy.example.com:80", exact=True)).to_be_visible()
                    expect(dialog.get_by_text("Total: 4 · New valid: 2 · Duplicates: 2 · Errors: 0", exact=True)).to_be_visible()
                    assert "import-password" not in dialog.inner_text()
                    assert "browser-test-proxy-secret" not in dialog.inner_text()
                    assert len(api("GET", base + "/proxies")) == 1
                    # Changing the default type invalidates a successful preview.
                    dialog.get_by_label("Default proxy type", exact=True).select_option("http")
                    expect(dialog.get_by_role("button", name="Import proxies", exact=True)).to_be_disabled()
                    dialog.get_by_label("Default proxy type", exact=True).select_option("https")
                    dialog.get_by_role("button", name="Preview import", exact=True).click()
                    expect(dialog.get_by_role("button", name="Import proxies", exact=True)).to_be_enabled()
                    page.screenshot(path=str(screenshots / "proxy-import.png"), full_page=True)
                    page.set_viewport_size({"width": 390, "height": 844})
                    page.screenshot(path=str(screenshots / "proxy-import-mobile.png"), full_page=True)
                    assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth"), "Mobile import overflow"
                    page.set_viewport_size({"width": 1440, "height": 1000})
                    with page.expect_response(lambda response: response.url.endswith("/proxies/import")
                                              and response.request.post_data_json.get("dry_run") is False) as imported:
                        dialog.get_by_role("button", name="Import proxies", exact=True).click()
                    assert imported.value.json()["imported"] == 2
                    expect(page.get_by_role("dialog")).not_to_be_visible()
                    expect(page.locator(".proxy-url")).to_have_count(3)
                    assert len(api("GET", base + "/proxies")) == 3

                    worker_id = str(uuid4())
                    agent_api("POST", "/heartbeat", json={"status": "healthy", "workers": [{
                        "id": worker_id, "name": "worker-1", "status": "running", "cpu_percent": 250.5,
                        "memory_mb": 84.2, "tasks_completed": 42,
                    }]})
                    agent_api("POST", "/errors", json={"worker_id": worker_id, "level": "warning", "message": "Job timeout reported"})
                    agent_api("POST", "/errors", json={"worker_id": worker_id, "level": "error", "message": "Connection temporarily unavailable"})
                    page.get_by_role("button", name="Refresh site", exact=True).click()
                    expect(page.locator(".detail-title .badge")).to_have_text("healthy")
                    page.get_by_role("tab", name=re.compile("^Workers")).click()
                    expect(page.get_by_text("250.5%", exact=True)).to_be_visible()

                    page.get_by_role("button", name="Start", exact=True).click()
                    expect(page.locator(".command-list .badge").first).to_have_text("pending")
                    cmd = agent_api("GET", "/commands")[0]
                    page.get_by_role("button", name="Refresh site", exact=True).click()
                    expect(page.locator(".command-list .badge").first).to_have_text("delivered")
                    agent_api("POST", f"/commands/{cmd['id']}/ack", json={"status": "completed"})
                    page.get_by_role("button", name="Refresh site", exact=True).click()
                    expect(page.locator(".command-list .badge").first).to_have_text("completed")
                    page.get_by_role("button", name="Stop", exact=True).click()
                    page.get_by_role("dialog").get_by_role("button", name="Dispatch stop").click()
                    expect(page.locator(".command-list .badge").first).to_have_text("pending")
                    # Queuing Stop must not fabricate a stopped worker snapshot.
                    expect(page.get_by_role("tabpanel").get_by_text("running", exact=True)).to_be_visible()

                    page.get_by_role("tab", name="Statistics", exact=True).click()
                    statistics = page.get_by_role("region", name="Site statistics", exact=True)
                    expect(statistics.get_by_text("Links Sent Successfully", exact=True)).to_be_visible()
                    expect(statistics.get_by_text("Average Messages Per Chat", exact=True)).to_be_visible()
                    assert api("GET", base + "/statistics")["updated_at"] is None
                    agent_api("POST", "/statistics", json={"links_sent_successfully": 274, "average_messages_per_chat": 6.25})
                    # A repeated absolute snapshot must not double counters.
                    agent_api("POST", "/statistics", json={"links_sent_successfully": 274, "average_messages_per_chat": 6.25})
                    assert api("GET", base + "/statistics")["links_sent_successfully"] == 274
                    expect(statistics.get_by_text("274", exact=True)).to_be_visible(timeout=15000)
                    expect(statistics.get_by_text("6.25", exact=True)).to_be_visible()
                    agent_api("POST", "/statistics", json={"links_sent_successfully": 0, "average_messages_per_chat": 0})
                    expect(statistics.locator(".detail-stat strong").first).to_have_text("0", timeout=15000)
                    expect(statistics.locator(".detail-stat strong").last).to_have_text("0")
                    agent_api("POST", "/statistics", json={"links_sent_successfully": 274, "average_messages_per_chat": None})
                    expect(statistics.locator(".detail-stat strong").last).to_have_text("—", timeout=15000)
                    agent_api("POST", "/statistics", json={"links_sent_successfully": 274, "average_messages_per_chat": 6.25})
                    expect(statistics.get_by_text("6.25", exact=True)).to_be_visible(timeout=15000)
                    page.screenshot(path=str(screenshots / "statistics-desktop.png"), full_page=True)

                    page.get_by_role("tab", name="Logs", exact=True).click()
                    page.get_by_label("Filter event severity").select_option("warning")
                    expect(page.get_by_text("Job timeout reported", exact=True)).to_be_visible()
                    expect(page.get_by_text("Connection temporarily unavailable", exact=True)).not_to_be_visible()
                    page.get_by_label("Search event logs").fill("no-such-message")
                    expect(page.get_by_text("No matching events", exact=True)).to_be_visible()
                    page.get_by_label("Search event logs").fill("")
                    page.get_by_label("Filter event severity").select_option("all")

                    for number in range(25):
                        agent_api("POST", "/errors", json={"level": "info", "message": f"Pagination fixture {number:02d}"})
                    page.get_by_role("button", name="Refresh site", exact=True).click()
                    events = page.locator(".events-panel")
                    expect(events.locator("tbody tr")).to_have_count(10)
                    expect(events.get_by_role("button", name="Previous log page", exact=True)).to_be_disabled()
                    first_page = events.locator("tbody").inner_text()
                    page.evaluate("window.__inlinePaginationSentinel = true")
                    events.get_by_role("button", name="Next log page", exact=True).click()
                    expect(events.locator("tbody tr")).to_have_count(10)
                    assert events.locator("tbody").inner_text() != first_page
                    assert page.evaluate("window.__inlinePaginationSentinel === true"), "Pagination must not reload the page"
                    page.get_by_role("button", name="Refresh site", exact=True).click()
                    expect(events.get_by_text("Page 2 of 3", exact=True)).to_be_visible()
                    events.get_by_role("button", name="Next log page", exact=True).click()
                    expect(events.locator("tbody tr")).to_have_count(7)
                    expect(events.get_by_role("button", name="Next log page", exact=True)).to_be_disabled()
                    # Filtering from a later page resets only this table's page.
                    page.get_by_label("Filter event severity").select_option("warning")
                    expect(events.locator("tbody tr")).to_have_count(1)
                    expect(page.get_by_text("Job timeout reported", exact=True)).to_be_visible()
                    expect(events.get_by_role("button", name="Previous log page", exact=True)).to_be_disabled()
                    page.get_by_label("Filter event severity").select_option("all")
                    expect(events.locator("tbody tr")).to_have_count(10)
                    page.screenshot(path=str(screenshots / "logs-pagination.png"), full_page=True)

                    page.get_by_role("tab", name="Overview", exact=True).click()
                    expect(page.get_by_role("region", name="Site statistics").get_by_text("274", exact=True)).to_be_visible()
                    page.screenshot(path=str(screenshots / "site-desktop.png"), full_page=True)
                    page.get_by_role("button", name="Workspace", exact=True).click()
                    expect(page.locator(".site-card")).to_be_visible()
                    page.get_by_role("button", name="Refresh", exact=True).click()
                    page.screenshot(path=str(screenshots / "overview-desktop.png"), full_page=True)
                    page.set_viewport_size({"width": 390, "height": 844})
                    assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth"), "Mobile page overflow"
                    page.screenshot(path=str(screenshots / "overview-mobile.png"), full_page=True)
                    page.get_by_role("button", name="Open navigation").click()
                    expect(page.locator(".sidebar")).to_be_visible()
                    page.get_by_role("button", name="Close navigation").last.click()
                    page.locator(".site-card").click()
                    expect(page.get_by_role("heading", name="Production storefront", exact=True)).to_be_visible()
                    assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth"), "Mobile detail overflow"
                    tabs = page.get_by_role("tablist", name="Site sections")
                    assert tabs.evaluate("el => getComputedStyle(el).overflowY === 'hidden' && el.scrollHeight <= el.clientHeight + 1"), "Site tabs must not scroll vertically"
                    assert tabs.evaluate("el => el.scrollWidth > el.clientWidth"), "Mobile tabs should scroll horizontally"
                    page.get_by_role("tab", name="Statistics", exact=True).click()
                    expect(page.get_by_role("region", name="Site statistics").get_by_text("6.25", exact=True)).to_be_visible()
                    page.screenshot(path=str(screenshots / "statistics-mobile.png"), full_page=True)
                    page.get_by_role("tab", name="Overview", exact=True).click()
                    page.screenshot(path=str(screenshots / "site-mobile.png"), full_page=True)

                    page.set_viewport_size({"width": 1440, "height": 1000})
                    page.get_by_role("tab", name="Backups", exact=True).click()
                    expect(page.get_by_text("No uploads received", exact=True)).to_be_visible()
                    expect(page.get_by_role("button", name="Request backup", exact=True)).to_be_disabled()
                    page.get_by_role("button", name="Add destination", exact=True).click()
                    dialog = page.get_by_role("dialog")
                    dialog.get_by_label("Destination name").fill("Browser cloud")
                    dialog.get_by_label("Configured remote").select_option("browser")
                    dialog.get_by_label("Cloud folder").fill("BrowserBackups")
                    dialog.get_by_role("button", name="Add shared destination", exact=True).click()
                    page.get_by_role("dialog").get_by_role("button", name="Add shared destination", exact=True).click()
                    expect(page.get_by_role("dialog")).not_to_be_visible()
                    page.get_by_role("checkbox", name=re.compile("^Browser cloud")).check()
                    page.get_by_role("switch").check()
                    page.get_by_label("Interval in minutes").fill("30")
                    page.get_by_role("button", name="Save settings", exact=True).click()
                    expect(page.get_by_text("Backup settings saved.", exact=False)).to_be_visible()
                    page.get_by_label("Interval in minutes").fill("45")
                    page.get_by_role("button", name="Refresh backups", exact=True).click()
                    expect(page.get_by_label("Interval in minutes")).to_have_value("45")
                    page.get_by_role("button", name="Discard edits", exact=True).click()
                    expect(page.get_by_label("Interval in minutes")).to_have_value("30")
                    with page.expect_response(lambda response: response.url.endswith("/backups/request")) as pending_backup:
                        page.get_by_role("button", name="Request backup", exact=True).click()
                    request_id = pending_backup.value.json()["id"]
                    expect(page.locator(".backup-request .badge").first).to_have_text("pending")
                    agent_api("GET", "/backup-requests")
                    payload = b"Any file type, including binary data: \x00\xff"
                    uploaded = requests.post(origin + "/api/agent/backups/upload", headers={**agent_headers, "Content-Type": "application/octet-stream"},
                                             params={"filename": "example.data", "source": "on_demand", "request_id": request_id},
                                             data=payload, timeout=10)
                    uploaded.raise_for_status()
                    backup_id = uploaded.json()["id"]
                    deadline = time.monotonic() + 30
                    while time.monotonic() < deadline:
                        history = api("GET", base + "/backups")
                        if any(item["id"] == backup_id and item["status"] == "completed" for item in history["backups"]):
                            break
                        time.sleep(0.2)
                    else:
                        raise AssertionError("Browser backup did not route to isolated test cloud")
                    cloud_file = cloud / "BrowserBackups" / site_id / backup_id / "example.data"
                    assert cloud_file.read_bytes() == payload
                    page.get_by_role("button", name="Refresh backups", exact=True).click()
                    expect(page.locator(".backup-record > .backup-row .badge").first).to_have_text("completed")
                    expect(page.locator(".backup-request .badge").first).to_have_text("uploaded")
                    page.screenshot(path=str(screenshots / "backups-desktop.png"), full_page=True)
                    page.set_viewport_size({"width": 390, "height": 844})
                    assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth"), "Mobile backups overflow"
                    page.screenshot(path=str(screenshots / "backups-mobile.png"), full_page=True)
                    page.set_viewport_size({"width": 1440, "height": 1000})
                    with page.expect_download() as downloaded:
                        page.get_by_role("button", name="Download cached example.data", exact=True).click()
                    assert Path(downloaded.value.path()).read_bytes() == payload
                    page.get_by_role("button", name="Evict cached example.data", exact=True).click()
                    page.get_by_role("dialog").get_by_role("button", name="Evict local cache", exact=True).click()
                    expect(page.get_by_role("button", name="Download cached example.data", exact=True)).to_be_disabled()
                    assert cloud_file.exists()
                    page.get_by_role("switch").uncheck()
                    page.get_by_role("checkbox", name=re.compile("^Browser cloud")).uncheck()
                    page.get_by_role("button", name="Save settings", exact=True).click()
                    expect(page.get_by_text("Backup settings saved.", exact=False)).to_be_visible()
                    page.get_by_role("button", name="Delete shared destination Browser cloud", exact=True).click()
                    page.get_by_role("dialog").get_by_role("button", name="Delete shared destination", exact=True).click()
                    expect(page.get_by_role("dialog")).not_to_be_visible()
                    expect(page.get_by_text("No cloud destinations", exact=True)).to_be_visible()
                    assert cloud_file.exists()
                    page.get_by_role("tab", name="Overview", exact=True).click()
                    page.get_by_role("button", name="Rotate agent token", exact=True).click()
                    page.get_by_role("dialog").get_by_role("button", name="Rotate token", exact=True).click()
                    expect(page.get_by_role("heading", name="Your agent token")).to_be_visible()
                    new_token = page.get_by_label("Agent token", exact=True).input_value()
                    assert new_token != agent_token
                    assert requests.get(origin + "/api/agent/config", headers=agent_headers, timeout=5).status_code == 401
                    page.get_by_role("button", name=re.compile("saved my token")).click()
                    page.get_by_role("button", name="Delete site", exact=True).click()
                    page.get_by_role("dialog").get_by_role("button", name="Delete site permanently").click()
                    expect(page.get_by_text("Your next automation starts here", exact=True)).to_be_visible()
                    assert api("GET", "/sites") == []
                    page.get_by_role("button", name="Sign out", exact=True).click()
                    expect(page.get_by_label("Admin password")).to_be_visible()
                    assert errors == [], errors
                    browser.close()
                    session.close()
                    print("Browser smoke passed: statistics, inline log pagination, horizontal-only tabs, auth, proxies, controls and cloud backups")
                    print("Screenshots: .qa/screenshots/")
            finally:
                server.terminate()
                try:
                    server.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    server.kill()
                    server.wait()


if __name__ == "__main__":
    main()
