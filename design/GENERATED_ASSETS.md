# Generated assets log

Every AI-generated asset in this repository. Generated imagery is **mood only**: it never
shows product UI, real people or anything presented as a real photograph. No image contains
model-rendered text; every word on screen is real typography in HTML. All product UI in the
screenshots (`docs/screenshots/`) and in the demo video is the running app.

## Images: Google Flow, Nano Banana Pro

- Tool: Google Flow via `gflow-cli` 0.80.0, `gflow image t2i --model nano-pro -n 3`, on the
  owner's Google AI Ultra account (default gflow profile, ai.marqigroup). Date: 2026-10-15.
- Cost: 0 Flow credits (image generation). **No Veo video was generated.**
- 6 prompts x 3 variants = 18 images; 4 chosen by hand. Raw variants stay in
  `design/gen/raw/` (git-ignored, not published). Prompts: `design/prompts.json`; script:
  `design/generate.py`; choice: `design/chosen.json`.
- Post-processing (`design/grade.py`): 0.6 % edge trim, optional crop to the target ratio,
  shadows pulled up to 18 % toward `--ink` #13212E and highlights toward `--deck` #F3EFE6,
  seeded fine grain. PNG masters in `design/art/`, WebP sizes in `web/public/art/`.

Shared style suffix appended to every prompt:

> Two-colour risograph print: deep navy ink and warm brass-ochre ink on uncoated cream
> paper. Flat overlapping shapes, visible paper grain and fine halftone dots, slight
> misregistration between the two inks, limited palette of navy, ochre and paper only, no
> gradients, no 3D render, no glossy surfaces, quiet editorial illustration with generous
> empty space. Absolutely no text, no letters, no numbers, no words, no logos, no signage,
> no money, no coins.

| Asset | Subject (full text in `design/prompts.json`) | Aspect | Chosen raw file | Used in |
| --- | --- | --- | --- | --- |
| `hero-wide` | Cabin on a lake at dusk, jetty, pontoon boat, canoe, pines | 16:9 -> 21:9 crop | `c0b261a6-..._1.jpg` (variant 2 of 3) | Home screen, Devpost cover, video opening |
| `cabin` | Cabin table set for eight, lantern, blank map, lake window | 4:3 | `330e1d3e-..._3.jpg` (variant 1) | New-event screen, video |
| `kayaks` | Four kayaks crossing a still lake from above | 16:9 | `b78b7059-..._1.jpg` (variant 3; variant 2 rejected for a stray third ink) | Video (optional extras scene) |
| `jetty` | Jetty with rope, cleat, duffel, paddles, moored boat | 1:1 | `de7d4bd3-..._2.jpg` (variant 2) | Video (vendor payout scene), Devpost gallery |
| `purse`, `tall` | Leather purse and compass still life; tall pines at dawn | 16:9, 9:16 | generated, not yet reviewed | Candidates for the video teaser |

## Text and code

- The app's runtime AI (Gemini) is described in README "AI tools used".
- Code and documents were written with Claude Code as a pair-programming assistant.
