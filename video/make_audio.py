"""Narration, music and captions for the Purser demo video.

    python video/make_audio.py

- Narration: Edge neural TTS per scene (narration.json), with word timings.
- Music: an original bed synthesised here from code (no samples, no third-party audio),
  ducked under the voice. Licence: ours (see CREDITS.md).
- Outputs: video/hyperframes/assets/mix.wav, video/timings.json, video/purser-demo.en.srt
"""
import asyncio
import json
import subprocess
from pathlib import Path

import edge_tts
import numpy as np
from scipy.io import wavfile

ROOT = Path(__file__).resolve().parent
WORK = ROOT / "work" / "tts"
ASSETS = ROOT / "hyperframes" / "assets"
WORK.mkdir(parents=True, exist_ok=True)
ASSETS.mkdir(parents=True, exist_ok=True)
SR = 48000
LEAD = 0.45  # voice starts this long after its scene
spec = json.loads((ROOT / "narration.json").read_text(encoding="utf-8"))


async def tts(scene):
    mp3 = WORK / f"{scene['id']}.mp3"
    words = []
    comm = edge_tts.Communicate(scene["text"], spec["voice"], rate=spec["rate"], boundary="WordBoundary")
    with open(mp3, "wb") as f:
        async for chunk in comm.stream():
            if chunk["type"] == "audio":
                f.write(chunk["data"])
            elif chunk["type"] == "WordBoundary":
                words.append({"w": chunk["text"], "t": chunk["offset"] / 1e7, "d": chunk["duration"] / 1e7})
    wav = WORK / f"{scene['id']}.wav"
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(mp3), "-ar", str(SR), "-ac", "1", str(wav)], check=True)
    sr, x = wavfile.read(wav)
    return x.astype(np.float32) / 32768.0, words


def music(seconds, seed=11):
    """Warm electric-piano chords over a soft pad and a low pulse; 80 bpm, F major."""
    rng = np.random.default_rng(seed)
    n = int(seconds * SR)
    t = np.arange(n) / SR
    out = np.zeros(n, np.float32)
    midi = lambda m: 440.0 * 2 ** ((m - 69) / 12)
    beat = 60 / 80
    bar = beat * 4
    chords = [[53, 60, 64, 69], [50, 57, 60, 65], [46, 53, 58, 62], [48, 55, 60, 64]]  # Fmaj7 Dm7 Bbmaj9 C
    for b in range(int(seconds / bar) + 1):
        ch = chords[b % 4]
        start = b * bar
        # pad: slow swell per bar
        i0, i1 = int(start * SR), min(n, int((start + bar + 0.6) * SR))
        if i0 >= n:
            break
        tt = t[i0:i1] - start
        env = np.minimum(1, tt / 0.9) * np.exp(-np.maximum(0, tt - bar) * 3)
        for m in ch:
            f = midi(m)
            out[i0:i1] += 0.018 * env * (np.sin(2 * np.pi * f * tt) + 0.3 * np.sin(2 * np.pi * f * 2.003 * tt + 0.4))
        # electric piano hits on beats 1 and 3 (+ a ghost on the "and" of 4)
        for k, off in enumerate([0, 2 * beat, 3.5 * beat]):
            s = start + off
            j0 = int(s * SR)
            if j0 >= n:
                continue
            j1 = min(n, j0 + int(2.2 * SR))
            tk = t[j0:j1] - s
            vel = [0.05, 0.04, 0.025][k] * (0.9 + 0.2 * rng.random())
            e = np.exp(-tk * 2.6) * np.minimum(1, tk / 0.004)
            for m in ch[1:]:
                f = midi(m + 12)
                out[j0:j1] += vel * e * (np.sin(2 * np.pi * f * tk) + 0.25 * np.sin(2 * np.pi * 2 * f * tk) * np.exp(-tk * 6))
        # bass
        j0 = int(start * SR)
        j1 = min(n, j0 + int(bar * SR))
        tb = t[j0:j1] - start
        fb = midi(ch[0] - 12)
        out[j0:j1] += 0.06 * np.exp(-tb * 0.9) * np.minimum(1, tb / 0.02) * np.sin(2 * np.pi * fb * tb)
    # gentle low-pass via moving average, fade in/out
    k = 6
    out = np.convolve(out, np.ones(k) / k, mode="same").astype(np.float32)
    fade = np.ones(n, np.float32)
    fi, fo = int(1.5 * SR), int(3.0 * SR)
    fade[:fi] = np.linspace(0, 1, fi)
    fade[-fo:] = np.linspace(1, 0, fo)
    return out * fade


def srt_time(s):
    ms = int(round(s * 1000))
    return f"{ms // 3600000:02d}:{ms // 60000 % 60:02d}:{ms // 1000 % 60:02d},{ms % 1000:03d}"


async def main():
    scenes = []
    clock = 0.0
    voices = []
    for sc in spec["scenes"]:
        x, words = await tts(sc)
        vd = len(x) / SR
        dur = max(sc["min"], LEAD + vd + spec["gap"])
        scenes.append({"id": sc["id"], "start": round(clock, 3), "duration": round(dur, 3), "voice": round(vd, 3), "text": sc["text"],
                       "words": [{**w, "t": round(clock + LEAD + w["t"], 3)} for w in words]})
        voices.append((clock + LEAD, x))
        clock += dur
    total = clock
    n = int(total * SR) + SR
    voice = np.zeros(n, np.float32)
    for at, x in voices:
        i = int(at * SR)
        voice[i:i + len(x)] += x
    bed = music(n / SR)[:n]
    bed = np.pad(bed, (0, n - len(bed)))
    # duck the bed under the voice (smoothed envelope)
    env = np.abs(voice)
    win = int(0.25 * SR)
    c = np.concatenate([[0.0], np.cumsum(env, dtype=np.float64)])
    idx = np.arange(len(env))
    lo = np.clip(idx - win // 2, 0, len(env))
    hi = np.clip(idx + win // 2, 0, len(env))
    env = ((c[hi] - c[lo]) / win).astype(np.float32)
    duck = 1 - 0.72 * np.clip(env / (env.max() * 0.15 + 1e-9), 0, 1)
    mix = 0.92 * voice + 0.55 * bed * duck
    peak = np.max(np.abs(mix))
    mix = mix / peak * 0.89
    wavfile.write(ASSETS / "mix.wav", SR, (mix * 32767).astype(np.int16))

    # captions: short lines from the word timings
    cues = []
    for sc in scenes:
        # Put the punctuation back: word boundaries carry bare words only.
        cur = 0
        for w in sc["words"]:
            at = sc["text"].find(w["w"], cur)
            if at < 0:
                continue
            end = at + len(w["w"])
            while end < len(sc["text"]) and sc["text"][end] not in " ":
                end += 1
            w["w"] = sc["text"][at:end]
            cur = end
        line, start = [], None
        for i, w in enumerate(sc["words"]):
            if start is None:
                start = w["t"]
            line.append(w)
            text = " ".join(x["w"] for x in line)
            nxt = sc["words"][i + 1] if i + 1 < len(sc["words"]) else None
            punct = text.endswith((".", ",", ":", "?", "!"))
            if not nxt or len(text) > 34 or (punct and len(text) > 16):
                end = w["t"] + w["d"] + 0.12
                if nxt:
                    end = min(end, nxt["t"])
                cues.append((start, end, text))
                line, start = [], None
    with open(ROOT / "purser-demo.en.srt", "w", encoding="utf-8", newline="\n") as f:
        for k, (a, b, txt) in enumerate(cues, 1):
            f.write(f"{k}\n{srt_time(a)} --> {srt_time(b)}\n{txt}\n\n")
    (ROOT / "timings.json").write_text(json.dumps({"total": round(total, 3), "scenes": scenes, "cues": cues}, indent=1), encoding="utf-8")
    print(f"total {total:.1f}s, {len(cues)} cues")
    for s in scenes:
        print(f"  {s['id']:12s} start {s['start']:6.2f}  dur {s['duration']:5.2f}  voice {s['voice']:5.2f}")


asyncio.run(main())
