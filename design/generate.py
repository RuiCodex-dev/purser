"""Generate Purser imagery with gflow-cli (Google Flow, Nano Banana Pro, 0 credits).

One `gflow image t2i` call per prompt, sequentially: the Flow Chrome profile is
shared machine-wide and only one call may hold it. A profile lock (exit 11) is
retried after a pause. Raw variants land in design/gen/raw/ (git-ignored).
"""
import json
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).parent
cfg = json.loads((HERE / "prompts.json").read_text(encoding="utf-8"))
only = set(sys.argv[1:])
for job in cfg["jobs"]:
    if only and job["name"] not in only:
        continue
    out = HERE / "gen" / "raw" / job["name"]
    if out.exists() and any(out.glob("*.jpg")) or any(out.glob("*.png")):
        print("skip", job["name"])
        continue
    out.mkdir(parents=True, exist_ok=True)
    prompt = f'{job["prompt"]} {cfg["style"]}'
    for attempt in range(8):
        r = subprocess.run(
            ["gflow", "image", "t2i", prompt, "--model", "nano-pro", "--aspect", job["aspect"],
             "-n", "3", "--out", str(out)],
            capture_output=True, text=True, encoding="utf-8", errors="replace",
        )
        if r.returncode == 11:
            print(job["name"], "profile locked, waiting")
            time.sleep(45)
            continue
        print(job["name"], "exit", r.returncode, (r.stderr or r.stdout)[-300:].strip() if r.returncode else "")
        break
