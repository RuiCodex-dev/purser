"""Records the real Purser app for the demo video (Chrome DevTools screencast).

    python scripts/record_demo.py <live-url> <fixtures-url> <out-dir>

<live-url> is a Purser running against the PayPal sandbox and Gemini; <fixtures-url>
one running with PURSER_PAYPAL_MODE=fixtures (the no-keys mode with its labelled
checkout simulator). Frames are kept with their timestamps and assembled into
constant-30fps MP4s, so the footage is the real app at real speed; the edit says
when it speeds a clip up. Nothing is typed into PayPal: the live clip stops on
PayPal's sandbox login page.
"""
import base64
import json
import subprocess
import sys
import threading
import time
import urllib.parse
import urllib.request
from pathlib import Path

from playwright.sync_api import sync_playwright

LIVE = sys.argv[1].rstrip("/")
FX = sys.argv[2].rstrip("/")
OUT = Path(sys.argv[3])
OUT.mkdir(parents=True, exist_ok=True)
VIEW = {"width": 1600, "height": 900}
DSF = 1.2  # 1920x1080 frames


class Recorder:
    def __init__(self, page, name):
        self.page, self.name = page, name
        self.dir = OUT / f"frames_{name}"
        self.dir.mkdir(parents=True, exist_ok=True)
        for f in self.dir.glob("*.jpg"):
            f.unlink()
        self.frames = []
        self.cdp = page.context.new_cdp_session(page)
        self.cdp.on("Page.screencastFrame", self.on_frame)
        self.marks = []

    def on_frame(self, p):
        path = self.dir / f"{len(self.frames):06d}.jpg"
        path.write_bytes(base64.b64decode(p["data"]))
        # The frame's own capture time: frames that wait in the queue keep their real timing.
        self.frames.append((path, float(p["metadata"].get("timestamp") or time.time())))
        try:
            self.cdp.send("Page.screencastFrameAck", {"sessionId": p["sessionId"]})
        except Exception:
            pass

    def mark(self, label):
        self.marks.append((label, round(time.time() - self.t0, 2)))

    def start(self):
        self.t0 = time.time()
        self.cdp.send("Page.startScreencast", {"format": "jpeg", "quality": 92, "maxWidth": 1920, "maxHeight": 1080, "everyNthFrame": 1})
        self.page.wait_for_timeout(300)

    def stop(self):
        self.t1 = time.time()
        self.cdp.send("Page.stopScreencast")
        self.page.wait_for_timeout(300)
        lst = OUT / f"{self.name}.txt"
        lines = []
        first = self.frames[0][1]
        lines.append(f"file '{self.frames[0][0].resolve().as_posix()}'\nduration {max(0.001, first - self.t0):.4f}")
        for k, (path, t) in enumerate(self.frames):
            nxt = self.frames[k + 1][1] if k + 1 < len(self.frames) else self.t1
            lines.append(f"file '{path.resolve().as_posix()}'\nduration {max(0.001, nxt - t):.4f}")
        lines.append(f"file '{self.frames[-1][0].resolve().as_posix()}'")
        lst.write_text("\n".join(lines), encoding="utf-8")
        mp4 = OUT / f"{self.name}.mp4"
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", str(lst),
                        "-vf", "fps=30,scale=1920:1080:flags=lanczos,format=yuv420p", "-c:v", "libx264", "-crf", "16",
                        "-preset", "medium", str(mp4)], check=True)
        return {"file": str(mp4), "seconds": round(self.t1 - self.t0, 2), "frames": len(self.frames), "marks": self.marks}


def get(base, path):
    with urllib.request.urlopen(base + path, timeout=300) as r:
        return json.load(r)


def post(base, path, body=None):
    req = urllib.request.Request(base + path, data=json.dumps(body or {}).encode(), method="POST", headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=300) as r:
        return json.load(r)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


def pay_over_http(base, link):
    """A participant pays through the real endpoints: pay link -> simulator approve -> return URL."""
    opener = urllib.request.build_opener(NoRedirect)

    def go(url, data=None):
        req = urllib.request.Request(url, data=data, method="POST" if data is not None else "GET",
                                     headers={"Content-Type": "application/x-www-form-urlencoded"})
        try:
            r = opener.open(req, timeout=120)
            return r.headers.get("Location")
        except urllib.error.HTTPError as e:
            return e.headers.get("Location")

    path = urllib.parse.urlparse(link).path
    checkout = go(base + path, b"")
    token = urllib.parse.parse_qs(urllib.parse.urlparse(checkout).query)["token"][0]
    back = go(base + "/sandbox-sim/checkout", f"token={token}&action=approve".encode())
    u = urllib.parse.urlparse(back)
    go(base + u.path + "?" + u.query)


def smooth_scroll(page, to_y, ms=1400, steps=50):
    y0 = page.evaluate("window.scrollY")
    for k in range(1, steps + 1):
        t = k / steps
        e = t * t * (3 - 2 * t)
        page.evaluate(f"window.scrollTo(0, {y0 + (to_y - y0) * e})")
        page.wait_for_timeout(ms / steps)


def y_of(page, locator, offset=0):
    box = locator.bounding_box()
    return page.evaluate("window.scrollY") + box["y"] + offset


def wait_run(page, timeout=300_000):
    page.wait_for_timeout(600)
    page.get_by_role("button", name="Run the treasurer").wait_for(timeout=timeout)


report = {}
with sync_playwright() as p:
    browser = p.chromium.launch(args=["--hide-scrollbars"])
    ctx = browser.new_context(viewport=VIEW, device_scale_factor=DSF, locale="en-US")
    page = ctx.new_page()

    # ---------------- LIVE: brief -> Gemini draft -> event
    page.goto(LIVE + "/#/")
    page.wait_for_timeout(1200)
    brief = get(LIVE, "/api/sample-brief")["text"]
    r = Recorder(page, "l1_brief")
    r.start()
    page.wait_for_timeout(1400)
    page.get_by_role("button", name="New event").first.click()
    page.wait_for_timeout(900)
    page.locator("textarea").first.click()
    page.keyboard.type(brief, delay=9)
    page.wait_for_timeout(700)
    r.mark("read")
    page.get_by_role("button", name="Read the brief").click()
    page.get_by_role("button", name="Create the event").wait_for(timeout=180_000)
    r.mark("draft")
    page.wait_for_timeout(1500)
    smooth_scroll(page, 520, ms=1800)
    page.wait_for_timeout(1500)
    smooth_scroll(page, 0, ms=900)
    page.get_by_role("button", name="Create the event").click()
    page.get_by_role("heading", name="Who owes what").wait_for()
    r.mark("event")
    page.wait_for_timeout(2200)
    report["l1"] = r.stop()

    # ---------------- LIVE: the treasurer runs through the Agent Toolkit
    r = Recorder(page, "l2_run")
    r.start()
    page.wait_for_timeout(800)
    r.mark("click")
    page.get_by_role("button", name="Run the treasurer").click()
    wait_run(page)
    r.mark("done")
    page.wait_for_timeout(2500)
    tabs = page.get_by_role("tab", name="PayPal objects")
    smooth_scroll(page, y_of(page, tabs, -120), ms=1600)
    tabs.click()
    r.mark("objects")
    page.wait_for_timeout(3500)
    report["l2"] = r.stop()
    page.screenshot(path=str(OUT / "still_live_objects.png"))

    # ---------------- LIVE: a pay link lands on PayPal's own sandbox page (we stop there)
    event_id = page.url.split("/e/")[1]
    view = get(LIVE, f"/api/events/{event_id}")
    pid = {x["name"]: x["id"] for x in view["event"]["participants"]}
    page.goto(view["payLinks"][pid["Priya"]])
    page.wait_for_timeout(800)
    r = Recorder(page, "l3_paypal")
    r.start()
    page.wait_for_timeout(2600)
    r.mark("pay")
    page.get_by_role("button", name="Pay").click()
    page.wait_for_url("**sandbox.paypal.com**", timeout=60_000)
    page.wait_for_load_state("networkidle", timeout=60_000)
    # PayPal picks the page language from the visitor's location; the video is English.
    if "locale.x=" not in page.url:
        page.goto(page.url + ("&" if "?" in page.url else "?") + "locale.x=en_US")
        page.wait_for_load_state("networkidle", timeout=60_000)
    r.mark("paypal")
    page.wait_for_timeout(3800)
    report["l3"] = r.stop()
    report["l3"]["paypal_host"] = urllib.parse.urlparse(page.url).netloc

    # ---------------- FIXTURES: the full money loop with the labelled checkout simulator
    created = post(FX, "/api/demo")
    fid = created["event"]["id"]
    page.goto(f"{FX}/#/e/{fid}")
    page.get_by_role("heading", name="Who owes what").wait_for()
    page.get_by_role("button", name="Run the treasurer").click()
    wait_run(page)
    view = get(FX, f"/api/events/{fid}")
    fpid = {x["name"]: x["id"] for x in view["event"]["participants"]}

    page.goto(view["payLinks"][fpid["Priya"]])
    page.wait_for_timeout(800)
    r = Recorder(page, "f1_pay")
    r.start()
    page.wait_for_timeout(2200)
    page.get_by_role("button", name="Pay").click()
    page.get_by_role("button", name="Approve as sandbox buyer").wait_for()
    r.mark("checkout")
    page.wait_for_timeout(2400)
    page.get_by_role("button", name="Approve as sandbox buyer").click()
    page.wait_for_load_state()
    r.mark("paid")
    page.wait_for_timeout(2600)
    report["f1"] = r.stop()

    # Organizer view: the ledger updates live while Sam pays from his own link.
    page.goto(f"{FX}/#/e/{fid}")
    page.get_by_role("heading", name="Who owes what").wait_for()
    page.wait_for_timeout(1200)
    r = Recorder(page, "f2_live")
    r.start()
    page.wait_for_timeout(1500)
    r.mark("sam-pays")
    t = threading.Thread(target=pay_over_http, args=(FX, view["payLinks"][fpid["Sam"]]))
    t.start()
    while t.is_alive():
        page.wait_for_timeout(100)
    page.wait_for_timeout(3500)
    report["f2"] = r.stop()

    for name in ["Lena", "Theo", "Ines", "Kofi"]:
        pay_over_http(FX, view["payLinks"][fpid[name]])
    page.wait_for_timeout(1500)

    # Everyone paid: reimbursements, the approval inbox, one click.
    r = Recorder(page, "f3_payouts")
    r.start()
    page.wait_for_timeout(1200)
    r.mark("run")
    page.get_by_role("button", name="Run the treasurer").click()
    wait_run(page)
    r.mark("done")
    page.wait_for_timeout(3000)
    approve = page.get_by_role("button", name="Approve and pay")
    if approve.count():
        approve.first.scroll_into_view_if_needed()
        page.wait_for_timeout(1500)
        r.mark("approve")
        approve.first.click()
        page.wait_for_timeout(3500)
    report["f3"] = r.stop()

    # Kofi drops out: refund on his capture, the others re-asked.
    page.evaluate("window.scrollTo(0, 0)")
    page.wait_for_timeout(600)
    r = Recorder(page, "f4_dropout")
    r.start()
    page.wait_for_timeout(1200)
    page.get_by_role("button", name="Kofi drops out").click()
    r.mark("dropped")
    page.wait_for_timeout(1400)
    page.get_by_role("button", name="Someone dropped out").click()
    page.wait_for_timeout(500)
    page.get_by_role("button", name="Run the treasurer").click()
    wait_run(page)
    r.mark("done")
    page.wait_for_timeout(3500)
    report["f4"] = r.stop()

    # Ask the ledger, then the PayPal objects and the audit log.
    page.evaluate("window.scrollTo(0, 0)")
    r = Recorder(page, "f5_ask")
    r.start()
    page.wait_for_timeout(1000)
    box = page.get_by_placeholder("Ask the ledger, e.g. who still owes more than $250?")
    box.click()
    page.keyboard.type("who still owes more than $250, largest first", delay=35)
    page.wait_for_timeout(400)
    r.mark("ask")
    page.get_by_role("button", name="Ask", exact=True).click()
    page.wait_for_timeout(5000)
    r.mark("answered")
    tabs = page.get_by_role("tab", name="PayPal objects")
    smooth_scroll(page, y_of(page, tabs, -120), ms=1600)
    tabs.click()
    page.wait_for_timeout(2600)
    page.get_by_role("tab", name="Activity log").click()
    r.mark("log")
    page.wait_for_timeout(3000)
    report["f5"] = r.stop()
    page.screenshot(path=str(OUT / "still_fx_log.png"))

    browser.close()

(OUT / "record_report.json").write_text(json.dumps(report, indent=1))
print(json.dumps(report, indent=1))
