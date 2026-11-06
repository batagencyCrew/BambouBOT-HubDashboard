"""Click through every dashboard screen in a real browser and fail on JS errors.

    BASE=http://127.0.0.1:18900 USER=owner PASSWORD=... python tests/browser_smoke_v2.py
Screenshots land in .qa/v2/.
"""

import os
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

BASE = os.environ.get("BASE", "http://127.0.0.1:18900")
USER = os.environ.get("USER_NAME", "owner")
PASSWORD = os.environ["PASSWORD"]
OUT = Path(__file__).resolve().parents[1] / ".qa" / "v2"
OUT.mkdir(parents=True, exist_ok=True)


def main() -> int:
    problems: list[str] = []
    with sync_playwright() as p:
        exe = os.environ.get("BROWSER_EXECUTABLE")
        browser = p.chromium.launch(executable_path=exe) if exe else p.chromium.launch()
        page = browser.new_page(viewport={"width": 1440, "height": 900})
        page.on("pageerror", lambda e: problems.append(f"pageerror: {e}"))
        page.on("console", lambda m: m.type == "error" and "404" not in m.text and "401" not in m.text and problems.append(f"console: {m.text}"))
        page.on("response", lambda r: r.status == 404 and "favicon" not in r.url and problems.append(f"HTTP 404 {r.url}"))
        page.on("response", lambda r: r.status >= 500 and problems.append(f"HTTP {r.status} {r.url}"))

        page.goto(f"{BASE}/")
        page.wait_for_url("**/login")
        page.get_by_label("Username").fill(USER)
        page.get_by_label("Password").fill(PASSWORD)
        page.get_by_role("button", name="Sign in").click()
        page.wait_for_url(f"{BASE}/")
        page.wait_for_selector("text=Overview")
        page.wait_for_timeout(1500)
        page.screenshot(path=OUT / "overview.png")

        slug = os.environ.get("SITE", "beta")
        for tab in ("overview", "workers", "logs", "metrics", "costs", "files", "proxies", "backups", "settings"):
            page.goto(f"{BASE}/sites/{slug}/{tab}")
            page.wait_for_timeout(1500)
            page.screenshot(path=OUT / f"site-{tab}.png")

        # Open a managed file in the editor.
        page.goto(f"{BASE}/sites/{slug}/files")
        page.wait_for_timeout(1000)
        link = page.get_by_text("config.json").first
        if link.count():
            link.click()
            page.wait_for_timeout(1000)
            page.screenshot(path=OUT / "file-editor.png", full_page=True)

        for path in ("alerts", "users", "audit"):
            page.goto(f"{BASE}/{path}")
            page.wait_for_timeout(1500)
            page.screenshot(path=OUT / f"{path}.png")

        page.goto(f"{BASE}/sites/{slug}/workers")
        page.go_back()
        page.wait_for_timeout(500)
        if "/audit" not in page.url:
            problems.append(f"Back button did not return to /audit (url={page.url})")
        browser.close()
    for problem in problems:
        print("PROBLEM", problem)
    print(f"{len(problems)} problems; screenshots in {OUT}")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
