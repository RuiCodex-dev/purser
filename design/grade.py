"""Grade the chosen Flow variants to the Purser palette and export app sizes.

Trims 0.6% of each edge (generator edge artifacts), pulls the darkest ink toward
--ink (#13212E) and the paper toward --deck (#F3EFE6) with a gentle curve, adds a
seeded fine grain so every image shares one paper, then writes PNG masters to
design/art/ and WebP sizes to web/public/art/.
"""
import json
from pathlib import Path
import numpy as np
from PIL import Image

HERE = Path(__file__).parent
WEB = HERE.parent / "web" / "public" / "art"
ART = HERE / "art"
ART.mkdir(exist_ok=True)
WEB.mkdir(parents=True, exist_ok=True)
CHOSEN = json.loads((HERE / "chosen.json").read_text())
INK = np.array([0x13, 0x21, 0x2E], float)
PAPER = np.array([0xF3, 0xEF, 0xE6], float)

for name, spec in CHOSEN.items():
    im = Image.open(HERE / "gen" / "raw" / name / spec["file"]).convert("RGB")
    w, h = im.size
    t = 0.006
    im = im.crop((int(w * t), int(h * t), int(w * (1 - t)), int(h * (1 - t))))
    if spec.get("ratio"):
        rw, rh = spec["ratio"]
        w, h = im.size
        nh = int(w * rh / rw)
        if nh < h:
            top = int((h - nh) * spec.get("anchor", 0.5))
            im = im.crop((0, top, w, top + nh))
    a = np.asarray(im).astype(float) / 255
    lum = a.mean(axis=2, keepdims=True)
    # pull shadows toward ink and highlights toward paper (max 18%)
    a = a * 255
    a = a + (INK - a) * np.clip(0.35 - lum, 0, 0.35) / 0.35 * 0.18
    a = a + (PAPER - a) * np.clip(lum - 0.82, 0, 0.18) / 0.18 * 0.18
    rng = np.random.default_rng(7)
    a = a + rng.normal(0, 3.0, a.shape[:2])[..., None]
    out = Image.fromarray(np.clip(a, 0, 255).astype("uint8"))
    out.save(ART / f"{name}.png", optimize=True)
    for width in spec["widths"]:
        im2 = out.resize((width, int(out.height * width / out.width)), Image.LANCZOS)
        suffix = "" if width == spec["widths"][0] else f"-{width}"
        im2.save(WEB / f"{name}{suffix}.webp", quality=82, method=6)
    print(name, out.size)
