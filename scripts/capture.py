"""Walks the running app through the demo story and saves screenshots.

    python scripts/capture.py http://localhost:8790 docs/screenshots [--dsf 2]

Uses headless Chromium via Playwright. Every image is a real capture of the
running app; nothing is mocked up.
"""
import json
import sys
import time
import urllib.request
from pathlib import Path

from playwright.sync_api import sync_playwright

BASE = sys.argv[1].rstrip("/") if len(sys.argv) > 1 else "http://localhost:8790"
OUT = Path(sys.argv[2] if len(sys.argv) > 2 else "docs/screenshots")
DSF = float(sys.argv[sys.argv.index("--dsf") + 1]) if "--dsf" in sys.argv else 1
OUT.mkdir(parents=True, exist_ok=True)


def post(path, body=None):
    req = urllib.request.Request(BASE + path, data=json.dumps(body or {}).encode(), method="POST",
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=300) as r:
        return json.load(r)


def shot(page, name, full=False):
    page.wait_for_timeout(500)
    page.screenshot(path=str(OUT / f"{name}.png"), full_page=full)
    print("saved", name)


with sync_playwright() as p:
    browser = p.chromium.launch()
    ctx = browser.new_context(viewport={"width": 1600, "height": 1000}, device_scale_factor=DSF)
    page = ctx.new_page()

    page.goto(BASE + "/#/")
    shot(page, "01-home")

    page.goto(BASE + "/#/new")
    page.get_by_role("button", name="Use the sample brief").click()
    page.wait_for_timeout(300)
    shot(page, "02-brief")
    page.get_by_role("button", name="Read the brief").click()
    page.get_by_role("button", name="Create the event").wait_for(timeout=120_000)
    shot(page, "03-draft")
    page.get_by_role("button", name="Create the event").click()
    page.get_by_role("heading", name="Who owes what").wait_for()
    shot(page, "04-event")

    page.get_by_role("button", name="Run the treasurer").click()
    page.wait_for_timeout(500)
    page.get_by_role("button", name="Run the treasurer").wait_for(timeout=240_000)
    page.wait_for_timeout(800)
    shot(page, "05-after-run")
    shot(page, "05b-after-run-full", full=True)

    event_id = page.url.split("/e/")[1]
    view = json.load(urllib.request.urlopen(f"{BASE}/api/events/{event_id}"))
    priya = next(x for x in view["event"]["participants"] if x["name"] == "Priya")
    payer = ctx.new_page()
    payer.set_viewport_size({"width": 760, "height": 980})
    payer.goto(view["payLinks"][priya["id"]])
    shot(payer, "06-pay-page")
    payer.get_by_role("button", name="Pay").click()
    payer.wait_for_load_state()
    shot(payer, "07-checkout")
    if payer.get_by_role("button", name="Approve as sandbox buyer").count():
        payer.get_by_role("button", name="Approve as sandbox buyer").click()
    payer.wait_for_load_state()
    payer.wait_for_timeout(800)
    shot(payer, "08-paid")

    page.bring_to_front()
    page.wait_for_timeout(1500)
    shot(page, "09-live-update")

    # Everyone else pays through their own link.
    for name in ["Sam", "Lena", "Theo", "Ines", "Kofi"]:
        pid = next(x for x in view["event"]["participants"] if x["name"] == name)["id"]
        payer.goto(view["payLinks"][pid])
        payer.get_by_role("button", name="Pay").click()
        payer.get_by_role("button", name="Approve as sandbox buyer").click()
        payer.wait_for_load_state()
    page.bring_to_front()
    page.wait_for_timeout(1500)
    shot(page, "10-all-paid")

    page.get_by_role("button", name="Run the treasurer").click()
    page.wait_for_timeout(500)
    page.get_by_role("button", name="Run the treasurer").wait_for(timeout=240_000)
    page.wait_for_timeout(2500)
    shot(page, "11-payouts")
    shot(page, "11b-payouts-full", full=True)

    if page.get_by_role("button", name="Approve and pay").count():
        page.get_by_role("button", name="Approve and pay").first.click()
        page.wait_for_timeout(3000)
    shot(page, "12-approved")

    page.get_by_role("button", name="Kofi drops out").click()
    page.wait_for_timeout(800)
    page.get_by_role("button", name="Someone dropped out").click()
    page.get_by_role("button", name="Run the treasurer").click()
    page.wait_for_timeout(500)
    page.get_by_role("button", name="Run the treasurer").wait_for(timeout=240_000)
    page.wait_for_timeout(2500)
    shot(page, "13-dropout")

    page.get_by_role("button", name="Owes more than $250, largest first").click()
    page.wait_for_timeout(4000)
    shot(page, "14-ask")
    page.get_by_role("button", name="Who is the pot paying back?").click()
    page.wait_for_timeout(4000)
    shot(page, "15-ask2")

    page.get_by_role("tab", name="Activity log").click()
    page.wait_for_timeout(600)
    page.locator(".tabs").scroll_into_view_if_needed()
    shot(page, "16-activity")
    page.get_by_role("tab", name="PayPal objects").click()
    page.wait_for_timeout(600)
    shot(page, "17-paypal-objects")

    browser.close()
