"""Devpost gallery images and thumbnail for Purser.

    python design/devpost/make_gallery.py

Every product image is a real frame of the running app (video/work/rec, recorded by
scripts/record_demo.py) or real script output; the only generated imagery is the Google
Flow risograph art logged in design/GENERATED_ASSETS.md. All words are real typography
(Fraunces, IBM Plex Sans, both SIL OFL), rendered here in HTML.
"""
import html
from pathlib import Path

from playwright.sync_api import sync_playwright

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
SRC = HERE / "src"
OUT = HERE / "out"
OUT.mkdir(exist_ok=True)
FONTS = (ROOT / "web" / "public" / "fonts").as_uri()

BASE_CSS = f"""
@font-face {{ font-family: Fraunces; src: url("{FONTS}/fraunces-var.woff2") format("woff2"); font-weight: 300 700; }}
@font-face {{ font-family: Plex; src: url("{FONTS}/plex-sans-var.woff2") format("woff2"); font-weight: 100 700; }}
* {{ margin: 0; padding: 0; box-sizing: border-box; }}
body {{ width: 1500px; height: 1000px; overflow: hidden; background: #F3EFE6; color: #13212E; font-family: Plex, sans-serif; font-variant-numeric: tabular-nums; position: relative; }}
.eb {{ font: 600 17px/1 Plex; letter-spacing: .22em; text-transform: uppercase; color: #7E5B1E; }}
h1 {{ font: 500 64px/1.02 Fraunces; letter-spacing: -.02em; margin-top: 18px; }}
.lede {{ font: 400 23px/1.45 Plex; color: #3c4954; margin-top: 18px; }}
.win {{ position: absolute; background: #FFFDF8; border-radius: 12px; overflow: hidden; box-shadow: 0 40px 70px -36px rgba(19,33,46,.55), 0 0 0 1px rgba(19,33,46,.12); }}
.win .bar {{ height: 28px; background: #E6DFD2; display: flex; gap: 7px; align-items: center; padding: 0 13px; }}
.win .bar i {{ width: 9px; height: 9px; border-radius: 50%; background: #C8BEAD; display: block; }}
.win .bar span {{ margin-left: 10px; font: 500 13px/1 Plex; color: #56616B; }}
.crop {{ position: relative; overflow: hidden; }}
.crop img {{ position: absolute; display: block; }}
.tag {{ display: inline-flex; align-items: center; gap: 10px; font: 600 16px/1 Plex; letter-spacing: .02em; }}
.tag b {{ width: 11px; height: 11px; border-radius: 50%; display: block; }}
.live b {{ background: #1E5B55; box-shadow: 0 0 0 4px rgba(30,91,85,.18); }}
.fx b {{ background: #A87A2C; box-shadow: 0 0 0 4px rgba(168,122,44,.2); }}
.foot {{ position: absolute; left: 70px; bottom: 44px; font: 600 15px/1 Plex; letter-spacing: .2em; text-transform: uppercase; color: #7E5B1E; }}
.pts {{ margin-top: 30px; }}
.pt {{ display: flex; gap: 14px; padding: 15px 0; border-top: 1px solid #DCD5C7; font: 400 21px/1.35 Plex; }}
.pt .n {{ font: 500 24px/1.1 Fraunces; color: #A87A2C; width: 22px; flex: none; }}
"""


def shot(src, x, y, w, h, scale, left, top, title="Purser"):
    """A window showing the region (x, y, w, h) of a 1920x1080 frame, scaled by `scale`."""
    W, H = round(w * scale), round(h * scale)
    return (f'<div class="win" style="left:{left}px;top:{top}px;width:{W}px;height:{H + 28}px">'
            f'<div class="bar"><i></i><i></i><i></i><span>{html.escape(title)}</span></div>'
            f'<div class="crop" style="width:{W}px;height:{H}px"><img src="{(SRC / src).as_uri()}" '
            f'style="width:{round(1920 * scale)}px;left:{-round(x * scale)}px;top:{-round(y * scale)}px"/></div></div>')


def text_block(eb, title, lede, pts=(), left=70, top=96, width=560, mode=None):
    tag = ""
    if mode == "live":
        tag = '<div class="tag live" style="margin-top:26px"><b></b>Live: PayPal sandbox + Gemini</div>'
    elif mode == "fx":
        tag = '<div class="tag fx" style="margin-top:26px"><b></b>No-keys demo mode: offline fixtures</div>'
    p = "".join(f'<div class="pt"><span class="n">{i + 1}</span><span>{t}</span></div>' for i, t in enumerate(pts))
    return (f'<div style="position:absolute;left:{left}px;top:{top}px;width:{width}px"><p class="eb">{eb}</p>'
            f'<h1>{title}</h1><p class="lede">{lede}</p>{tag}{"<div class=pts>" + p + "</div>" if pts else ""}</div>')


rogue = [l for l in (ROOT / "video" / "work" / "rogue.txt").read_text(encoding="utf-8").splitlines() if l.strip()]
rows = []
for line in rogue:
    if line.startswith(("DENY", "ALLOW")):
        v, rest = line.split(None, 1)
        tool, msg = rest.split(None, 1)
        c = "#A3372A;background:#F6E7E2" if v == "DENY" else "#1E5B55;background:#E3EEEA"
        rows.append(f'<div style="display:grid;grid-template-columns:104px 160px 1fr;gap:12px;padding:15px 0;border-bottom:1px dashed rgba(243,239,230,.14)">'
                    f'<span style="font:600 14px/1 Plex;letter-spacing:.12em;text-transform:uppercase;padding:7px 8px;border-radius:5px;text-align:center;color:{c}">{"denied" if v == "DENY" else "allowed"}</span>'
                    f'<span style="font:500 17px/1.35 Consolas,monospace;color:#E7C27E">{html.escape(tool)}</span>'
                    f'<span style="font:400 18px/1.4 Plex;color:#E9E4DA">{html.escape(msg)}</span></div>')
    else:
        rows.append(f'<div style="padding-top:16px;font:500 18px/1.3 Consolas,monospace;color:#9fd3c7">{html.escape(line)}</div>')
terminal = ('<div style="position:absolute;left:660px;top:120px;width:780px;background:#13212E;border-radius:12px;overflow:hidden;'
            'box-shadow:0 40px 70px -36px rgba(19,33,46,.6)"><div style="padding:14px 20px;background:#182a3a;font:500 16px/1 Consolas,monospace;color:#9fb0bd">'
            '$ node scripts/rogue-demo.ts</div><div style="padding:8px 20px 22px">' + "".join(rows) + "</div></div>")

purse = (ROOT / "design" / "devpost" / "src" / "purse.jpg").as_uri()

CARDS = {
    # Thumbnail / cover: Flow risograph still life + real typography.
    "00-cover": f'''<img src="{purse}" style="position:absolute;left:-40px;top:190px;width:720px;mix-blend-mode:multiply;-webkit-mask-image:radial-gradient(ellipse 62% 66% at 46% 50%, #000 58%, transparent 100%);mask-image:radial-gradient(ellipse 62% 66% at 46% 50%, #000 58%, transparent 100%)" alt=""/>
      <div style="position:absolute;left:660px;top:120px;width:780px">
        <p class="eb">PayPal AI Hackathon</p>
        <h1 style="font-size:136px;margin-top:20px">Purser</h1>
        <p style="font:400 42px/1.18 Fraunces;margin-top:16px;color:#2a3946">The AI treasurer for group events, with a mandate it can't break.</p>
        <p class="lede" style="margin-top:28px">Collects each share, pays people back, invoices sponsors and refunds drop-outs through PayPal. Every money move is checked against the ledger first.</p>
      </div>
      <div style="position:absolute;left:660px;top:720px;display:flex;gap:10px;flex-wrap:wrap;width:780px">
        {"".join(f'<span style="font:600 17px/1 Plex;padding:11px 15px;border-radius:999px;background:#13212E;color:#F3EFE6">{t}</span>' for t in ["PayPal Agent Toolkit", "Orders v2", "Invoicing", "Payouts", "Refunds", "Webhooks", "Gemini", "AG Grid"])}
      </div>
      <p class="foot">Rui Codex</p>''',
    "01-brief": text_block("1 / Read", "Write the trip like a group-chat message.", "Gemini turns it into a ledger: people, costs, who fronted what, the vendor still to be paid and the sponsor. Every name it returns must appear in the brief, or the strict parser takes over.", mode="live", width=450)
    + shot("draft.jpg", 330, 90, 1580, 930, 0.565, 560, 160, "Purser: new event"),
    "02-live": text_block("2 / Collect", "The treasurer works through the PayPal Agent Toolkit.", "One order per person for their exact share, an invoice sent to the sponsor, reimbursements held until the money arrives. Real sandbox ids in the PayPal objects grid.", mode="live", width=450)
    + shot("live-objects.jpg", 340, 110, 1100, 560, 0.82, 560, 210, "Purser: PayPal objects, sandbox"),
    "03-mandate": text_block("3 / The mandate", "The agent can only do what the ledger says is owed.", "Every money-moving call is normalised and checked in plain code before it reaches PayPal. A denied call goes back to the model with the reason.",
                             ["Orders match the ledger to the cent.", "Money only goes to people and vendors the ledger owes.", "Nothing leaves the pot before it arrives.", "Big moves wait for the organizer."], width=520)
    + terminal,
    "04-pay": text_block("4 / Pay", "A personal link, then PayPal's own checkout.", "Each person sees exactly what their share covers and pays with PayPal. Captured exactly once, however many paths ask for it.", mode="live", width=450)
    + shot("paid.jpg", 620, 20, 680, 980, 0.62, 570, 150, "Pay page (after paying)")
    + shot("paypal.jpg", 660, 120, 600, 760, 0.72, 1010, 190, "PayPal sandbox checkout"),
    "05-dropout": text_block("5 / Settle", "Drop-outs, refunds and payouts, to the cent.", "Kofi keeps his share of the non-refundable cabin, the rest is refunded on his own capture, and everyone else is re-asked for the difference.", mode="fx", width=450)
    + shot("dropout.jpg", 330, 0, 1580, 1000, 0.56, 560, 150, "Purser: after a drop-out"),
    "06-ask": text_block("6 / Audit", "Ask the ledger in plain English.", "A question becomes an AG Grid filter and sort. Every PayPal object and every mandate verdict is on the record, with PayPal debug ids.", mode="fx", width=450)
    + shot("log.jpg", 340, 100, 1090, 680, 0.8, 560, 170, "Purser: activity log"),
}

with sync_playwright() as p:
    b = p.chromium.launch()
    page = b.new_page(viewport={"width": 1500, "height": 1000}, device_scale_factor=1.2)
    for name, body in CARDS.items():
        doc = f"<!doctype html><html><head><meta charset='utf-8'><style>{BASE_CSS}</style></head><body>{body}</body></html>"
        f = OUT / f"{name}.html"
        f.write_text(doc, encoding="utf-8")
        page.goto(f.as_uri())
        page.evaluate("document.fonts.ready")
        page.wait_for_timeout(400)
        page.screenshot(path=str(OUT / f"{name}.jpg"), type="jpeg", quality=92)
        f.unlink()
        print("saved", name)
    # Devpost thumbnail (3:2) from the cover
    page.set_viewport_size({"width": 1500, "height": 1000})
    b.close()
