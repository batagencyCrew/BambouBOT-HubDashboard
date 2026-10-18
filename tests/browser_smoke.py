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

                    page.get_by_role("tab", name="Logs", exact=True).click()
                    page.get_by_label("Filter event severity").select_option("warning")
                    expect(page.get_by_text("Job timeout reported", exact=True)).to_be_visible()
                    expect(page.get_by_text("Connection temporarily unavailable", exact=True)).not_to_be_visible()
                    page.get_by_label("Search event logs").fill("no-such-message")
                    expect(page.get_by_text("No matching events", exact=True)).to_be_visible()
                    page.get_by_label("Search event logs").fill("")
                    page.get_by_label("Filter event severity").select_option("all")

                    page.get_by_role("tab", name="Overview", exact=True).click()
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
                    page.screenshot(path=str(screenshots / "site-mobile.png"), full_page=True)

                    page.set_viewport_size({"width": 1440, "height": 1000})
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
                    print("Browser smoke passed: auth, sites, secrets, proxy types and file imports, telemetry, commands, logs, mobile, rotation, deletion")
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
