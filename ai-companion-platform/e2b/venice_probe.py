# Runs INSIDE the E2B sandbox. Dry run: open Venice, screenshot the login/billing UI, list buttons. Never pays.
import sys, json
from playwright.sync_api import sync_playwright
out = {"steps": []}
with sync_playwright() as p:
    b = p.chromium.launch(args=["--no-sandbox","--disable-dev-shm-usage","--disable-gpu","--single-process"])
    pg = b.new_page(viewport={"width": 1280, "height": 900})
    pg.goto("https://venice.ai/settings/api", wait_until="domcontentloaded", timeout=45000); pg.wait_for_timeout(6000)
    out["url"] = pg.url
    out["title"] = pg.title()
    out["buttons"] = [t.strip() for t in pg.locator("button, a").all_inner_texts() if t.strip()][:40]
    pg.screenshot(path="/tmp/shot.png")
    b.close()
print(json.dumps(out))
