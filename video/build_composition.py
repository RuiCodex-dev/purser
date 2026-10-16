"""Writes video/hyperframes/index.html from video/timings.json (real narration timings).

    python video/build_composition.py

All product footage is the running app (scripts/record_demo.py). Live clips ran against the
PayPal sandbox and Gemini; the no-keys clips ran on offline fixtures with the labelled
checkout simulator, and the edit says so on screen. Speed-ups are labelled too.
"""
import html
import json
from pathlib import Path

VIDEO = Path(__file__).resolve().parent
ROOT = VIDEO / "hyperframes"
T = json.loads((VIDEO / "timings.json").read_text(encoding="utf-8"))
S = {s["id"]: s for s in T["scenes"]}
TOTAL = round(T["total"] + 0.4, 2)
st = {k: round(v["start"], 2) for k, v in S.items()}
du = {k: round(v["duration"], 2) for k, v in S.items()}
du["s11_end"] = round(TOTAL - st["s11_end"], 2)

LIVE = "Live &middot; PayPal sandbox + Gemini"
FX = "No-keys demo mode &middot; offline fixtures + labelled checkout simulator"


def clip(cid, src, start, dur, media=0.0, rate=1.0):
    return (f'<video id="{cid}" class="clip appvid" src="assets/clips/{src}.mp4" muted playsinline '
            f'data-start="{round(start, 2)}" data-duration="{round(dur, 2)}" data-media-start="{round(media, 2)}" '
            f'data-playback-rate="{rate}" data-track-index="3"></video>')


def window(scene, clips, badge, live, note=""):
    s, d = st[scene], du[scene]
    dot = "live" if live else "fx"
    return f'''
      <section class="scene clip paper" id="{scene}" data-start="{s}" data-duration="{d}" data-track-index="1"></section>
      <div class="win-group" id="{scene}-win">
        <div class="win clip" id="{scene}-chrome" data-start="{s}" data-duration="{d}" data-track-index="2"><div class="bar"><i></i><i></i><i></i><span>Purser &middot; localhost</span></div></div>
        {"".join(clips)}
      </div>
      <div class="badge clip" id="{scene}-badge" data-start="{s}" data-duration="{d}" data-track-index="6"><b class="{dot}"></b><span>{badge}</span>{f'<em>{note}</em>' if note else ''}</div>'''


def callout(cid, scene, at, dur, text, top, side="right"):
    pos = f"{side}: 64px; top: {top}px;"
    return f'<div class="callout clip" id="{cid}" style="{pos}" data-start="{round(st[scene] + at, 2)}" data-duration="{round(dur, 2)}" data-track-index="7"><span>{text}</span></div>'


caps = "\n".join(
    f'      <div class="cap clip" id="cap{i}" data-start="{round(a, 2)}" data-duration="{round(b - a, 2)}" data-track-index="9"><span>{html.escape(t)}</span></div>'
    for i, (a, b, t) in enumerate(T["cues"])
)

rogue = [line for line in (VIDEO / "work" / "rogue.txt").read_text(encoding="utf-8").splitlines() if line.strip()]
term_lines = []
for k, line in enumerate(rogue):
    if line.startswith(("DENY", "ALLOW")):
        verdict, rest = line.split(None, 1)
        tool, msg = rest.split(None, 1)
        cls = "deny" if verdict == "DENY" else "allow"
        word = "denied" if cls == "deny" else "allowed"
        term_lines.append(f'<div class="tl" id="tl{k}"><span class="v {cls}">{word}</span><span class="tool">{html.escape(tool)}</span><span class="msg">{html.escape(msg)}</span></div>')
    else:
        term_lines.append(f'<div class="tl foot" id="tl{k}">{html.escape(line)}</div>')
term = "\n          ".join(term_lines)

# footage plan (media seconds come from video/work/rec/record_report.json marks)
s02 = window("s02_home", [clip("v02", "l1_brief", st["s02_home"], du["s02_home"], 0.0, 1.0)], LIVE, True)
r03 = 2.1
s03 = window("s03_brief", [clip("v03", "l1_brief", st["s03_brief"], du["s03_brief"], du["s02_home"], r03)], LIVE, True, "2.1&times; speed")
r04 = 2.5
s04 = window("s04_run", [clip("v04", "l2_run", st["s04_run"], du["s04_run"], 0.0, r04)], LIVE + " &middot; PayPal Agent Toolkit", True, "2.5&times; speed")
a05 = 3.1
s05 = window("s05_paypal", [clip("v05a", "l3_paypal", st["s05_paypal"], a05, 0.0, 1.0),
                            clip("v05b", "l3_paypal", st["s05_paypal"] + a05, du["s05_paypal"] - a05, 10.4, 1.0)],
             LIVE + " &middot; PayPal's own sandbox checkout (we stop before signing in)", True)
a06 = 7.6
s06 = window("s06_paid", [clip("v06a", "f1_pay", st["s06_paid"], a06, 0.0, 1.0),
                          clip("v06b", "f2_live", st["s06_paid"] + a06, du["s06_paid"] - a06, 0.0, 1.0)], FX, False)
s08 = window("s08_payouts", [clip("v08", "f3_payouts", st["s08_payouts"], du["s08_payouts"], 0.0, 3.5)], FX, False, "3.5&times; speed")
s09 = window("s09_dropout", [clip("v09", "f4_dropout", st["s09_dropout"], du["s09_dropout"], 0.0, 1.65)], FX, False, "1.6&times; speed")
s10 = window("s10_ask", [clip("v10", "f5_ask", st["s10_ask"], du["s10_ask"], 0.0, 1.7)], FX, False, "1.7&times; speed")

calls = "\n      ".join([
    callout("c03a", "s03_brief", 3.4, 5.4, "Gemini reads the brief into a typed budget", 150),
    callout("c03b", "s03_brief", 12.4, 4.6, "Grounding check: every name must be in the brief", 150),
    callout("c04a", "s04_run", 4.0, 6.0, "<b>create_order</b> &times; 6 &middot; Agent Toolkit", 150),
    callout("c04b", "s04_run", 9.0, 5.0, "<b>create_invoice</b> + <b>send_invoice</b> &middot; sponsor", 228),
    callout("c04c", "s04_run", 13.0, 5.0, "Payouts wait: the pot is still empty", 306),
    callout("c06a", "s06_paid", 2.4, 5.0, "Offline checkout simulator, clearly labelled", 150),
    callout("c06b", "s06_paid", 8.6, 6.4, "Captured once &middot; webhook updates the ledger live", 150),
    callout("c08a", "s08_payouts", 9.2, 3.8, "Payouts v1 &middot; Jonah reimbursed, under the limit", 150),
    callout("c08b", "s08_payouts", 10.2, 2.8, "Maya&rsquo;s $1,248.50: above the limit, one click", 228),
    callout("c09a", "s09_dropout", 9.4, 3.6, "Refund on Kofi's capture &middot; others re-asked, to the cent", 150),
    callout("c10a", "s10_ask", 3.0, 4.6, "Plain English &rarr; AG Grid filter + sort", 150),
])

out = f'''<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=1920, height=1080" />
    <script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
    <style>
      @font-face {{ font-family: "Fraunces"; src: url("assets/fonts/fraunces-var.woff2") format("woff2"); font-weight: 300 700; font-style: normal; }}
      @font-face {{ font-family: "IBM Plex Sans"; src: url("assets/fonts/plex-sans-var.woff2") format("woff2"); font-weight: 100 700; font-style: normal; }}
      * {{ margin: 0; padding: 0; box-sizing: border-box; }}
      html, body {{ margin: 0; width: 1920px; height: 1080px; overflow: hidden; background: #0E1922; }}
      #root {{ width: 100%; height: 100%; position: relative; overflow: hidden; background: #0E1922; font-family: "IBM Plex Sans", sans-serif; color: #F3EFE6; font-variant-numeric: tabular-nums; }}
      .scene {{ position: absolute; inset: 0; overflow: hidden; }}
      .paper {{ background: #F3EFE6; }}
      .night {{ background: #0E1922; }}
      .eyebrow {{ font: 600 22px/1 "IBM Plex Sans"; letter-spacing: .22em; text-transform: uppercase; color: #C9A25A; }}
      /* open */
      #s01_open .print {{ position: absolute; right: 90px; top: 170px; width: 940px; height: 403px; overflow: hidden; border-radius: 6px; box-shadow: 0 50px 90px -40px rgba(0,0,0,.7); }}
      #s01_open .print img {{ width: 100%; height: 100%; object-fit: cover; display: block; }}
      #s01_open .copy {{ position: absolute; left: 120px; top: 250px; width: 700px; }}
      #s01_open h1 {{ font: 500 160px/0.95 "Fraunces"; letter-spacing: -0.02em; color: #F3EFE6; margin-top: 26px; }}
      #s01_open .sub {{ font: 400 42px/1.18 "Fraunces"; color: #E9DEC8; margin-top: 26px; }}
      #s01_open .list {{ position: absolute; left: 120px; right: 90px; top: 690px; display: flex; gap: 0; border-top: 1px solid rgba(243,239,230,.18); }}
      #s01_open .it {{ flex: 1; padding: 26px 26px 0 0; font: 400 26px/1.3 "IBM Plex Sans"; color: rgba(243,239,230,.82); }}
      #s01_open .it b {{ display: block; font: 500 40px/1.1 "Fraunces"; color: #F3EFE6; margin-bottom: 8px; }}
      /* app windows */
      .win-group {{ position: absolute; left: 180px; top: 34px; width: 1560px; height: 912px; transform-origin: 50% 50%; }}
      .win {{ position: absolute; inset: 0; border-radius: 14px; background: #FFFDF8; box-shadow: 0 40px 80px -40px rgba(19,33,46,.6), 0 0 0 1px rgba(19,33,46,.14); overflow: hidden; }}
      .win .bar {{ height: 34px; background: #E6DFD2; display: flex; align-items: center; gap: 8px; padding: 0 16px; }}
      .win .bar i {{ width: 11px; height: 11px; border-radius: 50%; background: #C8BEAD; display: block; }}
      .win .bar span {{ margin-left: 14px; font: 500 15px/1 "IBM Plex Sans"; color: #56616B; letter-spacing: .03em; }}
      .appvid {{ position: absolute; left: 0; top: 34px; width: 1560px; height: 878px; border-radius: 0 0 14px 14px; object-fit: cover; }}
      .badge {{ position: absolute; left: 180px; top: 958px; display: flex; align-items: center; gap: 12px; font: 600 21px/1 "IBM Plex Sans"; color: #13212E; letter-spacing: .02em; }}
      .badge b {{ width: 12px; height: 12px; border-radius: 50%; display: block; }}
      .badge b.live {{ background: #1E5B55; box-shadow: 0 0 0 5px rgba(30,91,85,.18); }}
      .badge b.fx {{ background: #A87A2C; box-shadow: 0 0 0 5px rgba(168,122,44,.2); }}
      .badge em {{ font-style: normal; font-weight: 500; color: #6A4C17; margin-left: 10px; padding-left: 14px; border-left: 1px solid #DCD5C7; }}
      .callout {{ position: absolute; display: flex; justify-content: flex-end; }}
      .callout span {{ display: block; background: #13212E; color: #F3EFE6; font: 500 25px/1.25 "IBM Plex Sans"; padding: 16px 24px; border-radius: 10px; border-left: 5px solid #C9A25A; box-shadow: 0 24px 40px -20px rgba(0,0,0,.55); max-width: 560px; }}
      .callout b {{ font-weight: 600; color: #E7C27E; }}
      /* mandate */
      #s07_mandate .copy {{ position: absolute; left: 120px; top: 120px; width: 690px; }}
      #s07_mandate h2 {{ font: 500 84px/1 "Fraunces"; letter-spacing: -0.015em; margin-top: 22px; color: #F3EFE6; }}
      .rule {{ display: flex; gap: 20px; padding: 24px 0; border-top: 1px solid rgba(243,239,230,.16); font: 400 30px/1.3 "IBM Plex Sans"; color: rgba(243,239,230,.9); }}
      .rule .n {{ font: 500 34px/1.1 "Fraunces"; color: #C9A25A; width: 34px; flex: none; }}
      #s07_mandate .rules {{ margin-top: 40px; }}
      .term {{ position: absolute; left: 880px; top: 150px; width: 930px; background: #13212E; border-radius: 14px; box-shadow: 0 50px 90px -40px rgba(0,0,0,.8), 0 0 0 1px rgba(243,239,230,.08); overflow: hidden; }}
      .term .tbar {{ padding: 16px 22px; background: #182a3a; font: 500 19px/1 ui-monospace, Consolas, monospace; color: #9fb0bd; }}
      .term .body {{ padding: 18px 22px 26px; }}
      .tl {{ display: grid; grid-template-columns: 120px 190px 1fr; gap: 14px; align-items: start; padding: 16px 0; border-bottom: 1px dashed rgba(243,239,230,.12); }}
      .tl .v {{ font: 600 17px/1 "IBM Plex Sans"; letter-spacing: .12em; text-transform: uppercase; padding: 8px 10px; border-radius: 6px; text-align: center; }}
      .tl .v.deny {{ background: #F6E7E2; color: #A3372A; }}
      .tl .v.allow {{ background: #E3EEEA; color: #1E5B55; }}
      .tl .tool {{ font: 500 20px/1.35 ui-monospace, Consolas, monospace; color: #E7C27E; }}
      .tl .msg {{ font: 400 21px/1.35 "IBM Plex Sans"; color: #E9E4DA; }}
      .tl.foot {{ display: block; border: 0; padding-top: 20px; font: 500 22px/1.3 ui-monospace, Consolas, monospace; color: #9fd3c7; }}
      .src {{ position: absolute; left: 880px; top: 860px; font: 400 21px/1.4 "IBM Plex Sans"; color: rgba(243,239,230,.6); width: 930px; }}
      /* end */
      #s11_end .print {{ position: absolute; left: 110px; top: 150px; width: 820px; height: 612px; overflow: hidden; border-radius: 6px; box-shadow: 0 50px 90px -40px rgba(0,0,0,.7); }}
      #s11_end .print img {{ width: 100%; height: 100%; object-fit: cover; display: block; }}
      #s11_end .copy {{ position: absolute; left: 1030px; top: 230px; width: 800px; }}
      #s11_end .mark {{ font: 500 170px/0.95 "Fraunces"; letter-spacing: -0.02em; color: #F3EFE6; }}
      #s11_end .tag {{ margin-top: 26px; font: 400 44px/1.2 "Fraunces"; color: #E9DEC8; }}
      #s11_end .stack {{ margin-top: 54px; font: 500 24px/1.6 "IBM Plex Sans"; color: rgba(243,239,230,.78); }}
      #s11_end .stack .ln {{ display: block; }}
      #s11_end .by {{ margin-top: 40px; font: 600 26px/1 "IBM Plex Sans"; letter-spacing: .22em; text-transform: uppercase; color: #C9A25A; }}
      /* captions */
      .cap {{ position: absolute; left: 0; right: 0; bottom: 22px; display: flex; justify-content: center; }}
      .cap span {{ background: rgba(14,25,34,.86); color: #F3EFE6; font: 500 32px/1.3 "IBM Plex Sans"; padding: 9px 22px; border-radius: 10px; max-width: 1500px; text-align: center; }}
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="main" data-start="0" data-duration="{TOTAL}" data-width="1920" data-height="1080">

      <section class="scene clip night" id="s01_open" data-start="0" data-duration="{du['s01_open']}" data-track-index="1">
        <div class="print"><img id="open-img" src="assets/img/hero-wide.jpg" alt="" /></div>
        <div class="copy">
          <p class="eyebrow" id="open-eb">PayPal AI Hackathon &middot; Rui Codex</p>
          <h1 id="open-h">Purser</h1>
          <p class="sub" id="open-sub">The AI treasurer for group events.</p>
        </div>
        <div class="list">
          <div class="it" id="oi1"><b>Fronts the cabin</b>$1,480 on one card</div>
          <div class="it" id="oi2"><b>Chases eight friends</b>$276.50 each, to the cent</div>
          <div class="it" id="oi3"><b>Pays the boat</b>a vendor still to be paid</div>
          <div class="it" id="oi4"><b>Refunds the drop-out</b>only the refundable part</div>
        </div>
      </section>
{s02}
{s03}
{s04}
{s05}
{s06}

      <section class="scene clip night" id="s07_mandate" data-start="{st['s07_mandate']}" data-duration="{du['s07_mandate']}" data-track-index="1">
        <div class="copy">
          <p class="eyebrow" id="m-eb">The mandate</p>
          <h2 id="m-h">Checked in plain code, before PayPal.</h2>
          <div class="rules">
            <div class="rule" id="r1"><span class="n">1</span><span>An order must match the ledger to the cent.</span></div>
            <div class="rule" id="r2"><span class="n">2</span><span>Money only goes to people and vendors the ledger owes.</span></div>
            <div class="rule" id="r3"><span class="n">3</span><span>Nothing leaves the pot before it has arrived.</span></div>
            <div class="rule" id="r4"><span class="n">4</span><span>Big moves wait for the organizer.</span></div>
          </div>
        </div>
        <div class="term" id="term">
          <div class="tbar">$ node scripts/rogue-demo.ts &nbsp;&middot;&nbsp; a scripted rogue model vs the real mandate</div>
          <div class="body">
          {term}
          </div>
        </div>
        <p class="src" id="m-src">Output of the repository's own script (same scenario as test/agent.test.ts). Each denial goes back to the model with the ledger's expected value.</p>
      </section>
{s08}
{s09}
{s10}

      <section class="scene clip night" id="s11_end" data-start="{st['s11_end']}" data-duration="{du['s11_end']}" data-track-index="1">
        <div class="print"><img id="end-img" src="assets/img/cabin.jpg" alt="" /></div>
        <div class="copy">
          <div class="mark" id="end-mark">Purser</div>
          <p class="tag" id="end-tag">The treasurer you can trust with the trip money.</p>
          <div class="stack" id="end-stack"><span class="ln">PayPal Orders v2 &middot; Invoicing &middot; Payouts &middot; Refunds &middot; Webhooks</span><span class="ln">PayPal Agent Toolkit &middot; Gemini &middot; AG Grid</span></div>
          <p class="by" id="end-by">Rui Codex</p>
        </div>
      </section>

      {calls}

      <audio id="mix" src="assets/mix.wav" data-start="0" data-duration="{TOTAL}" data-track-index="10" data-volume="1"></audio>

{caps}
    </div>
    <script>
      const tl = gsap.timeline({{ paused: true }});
      const E = "power3.out";
      const S = {json.dumps(st)};
      const D = {json.dumps(du)};
      // open
      tl.fromTo("#open-img", {{ scale: 1.0 }}, {{ scale: 1.08, duration: D.s01_open, ease: "none" }}, 0);
      tl.fromTo("#open-eb", {{ opacity: 0, y: 14 }}, {{ opacity: 1, y: 0, duration: 0.8, ease: E }}, 0.3);
      tl.fromTo("#open-h", {{ opacity: 0, y: 30 }}, {{ opacity: 1, y: 0, duration: 0.9, ease: E }}, 0.6);
      tl.fromTo("#open-sub", {{ opacity: 0, y: 20 }}, {{ opacity: 1, y: 0, duration: 0.8, ease: E }}, 1.3);
      [["#oi1", 2.6], ["#oi2", 4.2], ["#oi3", 6.3], ["#oi4", 7.9]].forEach(([s, t]) =>
        tl.fromTo(s, {{ opacity: 0, y: 18 }}, {{ opacity: 1, y: 0, duration: 0.6, ease: E }}, t));
      // app windows rise in
      ["s02_home", "s03_brief", "s04_run", "s05_paypal", "s06_paid", "s08_payouts", "s09_dropout", "s10_ask"].forEach((k) => {{
        tl.fromTo(`#${{k}}-win`, {{ opacity: 0, y: 26, scale: 0.985 }}, {{ opacity: 1, y: 0, scale: 1, duration: 0.55, ease: E }}, S[k]);
        tl.fromTo(`#${{k}}-badge span`, {{ opacity: 0 }}, {{ opacity: 1, duration: 0.5 }}, S[k] + 0.3);
      }});
      // a slow push into the trace while the treasurer runs
      tl.to("#s04_run-win", {{ scale: 1.04, x: -30, duration: D.s04_run - 1, ease: "power1.inOut" }}, S.s04_run + 0.8);
      // punch in on the narrow pay pages, back out for the full ledger
      tl.to("#s05_paypal-win", {{ scale: 1.24, y: 40, duration: 1.2, ease: "power2.inOut" }}, S.s05_paypal + 0.7);
      tl.to("#s05_paypal-win", {{ scale: 1.0, y: 0, duration: 0.6, ease: "power2.inOut" }}, S.s05_paypal + 2.4);
      tl.to("#s05_paypal-win", {{ scale: 1.22, y: 30, duration: 1.4, ease: "power2.inOut" }}, S.s05_paypal + 3.6);
      tl.to("#s06_paid-win", {{ scale: 1.24, y: 50, duration: 1.2, ease: "power2.inOut" }}, S.s06_paid + 0.6);
      tl.to("#s06_paid-win", {{ scale: 1.0, y: 0, duration: 0.7, ease: "power2.inOut" }}, S.s06_paid + {a06} - 0.5);
      // callouts
      document.querySelectorAll(".callout span").forEach((el) => {{
        const s = parseFloat(el.parentElement.dataset.start);
        tl.fromTo(el, {{ opacity: 0, x: 24 }}, {{ opacity: 1, x: 0, duration: 0.45, ease: E }}, s);
      }});
      // mandate
      tl.fromTo("#m-eb", {{ opacity: 0 }}, {{ opacity: 1, duration: 0.5 }}, S.s07_mandate + 0.2);
      tl.fromTo("#m-h", {{ opacity: 0, y: 22 }}, {{ opacity: 1, y: 0, duration: 0.7, ease: E }}, S.s07_mandate + 0.4);
      tl.fromTo("#term", {{ opacity: 0, y: 30 }}, {{ opacity: 1, y: 0, duration: 0.7, ease: E }}, S.s07_mandate + 1.0);
      [["#r1", 3.0], ["#r2", 5.2], ["#r3", 7.6], ["#r4", 9.6]].forEach(([s, t]) =>
        tl.fromTo(s, {{ opacity: 0, x: -18 }}, {{ opacity: 1, x: 0, duration: 0.55, ease: E }}, S.s07_mandate + t));
      const tls = Array.from(document.querySelectorAll(".tl"));
      tls.forEach((el, k) => tl.fromTo(el, {{ opacity: 0, y: 10 }}, {{ opacity: 1, y: 0, duration: 0.45, ease: E }}, S.s07_mandate + 8.4 + k * 1.35));
      tl.fromTo("#m-src", {{ opacity: 0 }}, {{ opacity: 1, duration: 0.6 }}, S.s07_mandate + 14.5);
      // end
      tl.fromTo("#end-img", {{ scale: 1.06 }}, {{ scale: 1.0, duration: D.s11_end, ease: "none" }}, S.s11_end);
      tl.fromTo("#end-mark", {{ opacity: 0, y: 24 }}, {{ opacity: 1, y: 0, duration: 0.9, ease: E }}, S.s11_end + 0.3);
      tl.fromTo("#end-tag", {{ opacity: 0, y: 18 }}, {{ opacity: 1, y: 0, duration: 0.8, ease: E }}, S.s11_end + 1.1);
      tl.fromTo(["#end-stack", "#end-by"], {{ opacity: 0 }}, {{ opacity: 1, duration: 0.8, stagger: 0.4 }}, S.s11_end + 2.4);
      // captions
      document.querySelectorAll(".cap span").forEach((el) => {{
        const s = parseFloat(el.parentElement.dataset.start);
        tl.fromTo(el, {{ opacity: 0 }}, {{ opacity: 1, duration: 0.15 }}, s);
      }});
      window.__timelines["main"] = tl;
    </script>
  </body>
</html>
'''
(ROOT / "index.html").write_text(out, encoding="utf-8")
print("total", TOTAL, {k: (st[k], du[k]) for k in st})
