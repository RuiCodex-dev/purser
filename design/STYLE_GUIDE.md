# Purser style guide

Purser is a ship's purser: the officer who keeps the money, the manifest and the log, and
answers to the captain. The product should feel like a well-kept ledger book, not a crypto
dashboard: paper, ink, brass fittings, careful columns. Calm, exact, a little nautical, never
cute. Every surface (the organizer app, the participant pay page, the Devpost images and the
video) uses this one system.

## Voice

- A careful treasurer talking to a friend who organises trips. Short sentences, real numbers,
  no hype, no exclamation marks, no emoji.
- Always separate **what the ledger computed** (shares, positions) from **what the agent
  decided** (the calls it made) and **what the mandate allowed** (allow / needs approval /
  denied). Say "the mandate stopped it", never "the AI refused".
- Money is written with its currency every time ($276.50), never as a bare number.
- Participants are people: name them, never "user 3".

## Palette

CSS custom properties in `web/src/styles.css` (and mirrored in `server/http/pages.ts`).

| Token | Hex | Use |
| --- | --- | --- |
| `--ink` | `#13212E` | Body text, the left rail, primary buttons |
| `--night` | `#0E1922` | Video backgrounds, the rail's deepest layer |
| `--deck` | `#F3EFE6` | Page background (paper) |
| `--sheet` | `#FFFDF8` | Cards and grids on paper |
| `--rule` | `#DCD5C7` | Hairlines, grid borders, dashed ledger rules |
| `--fog` | `#56616B` | Secondary text |
| `--brass` | `#A87A2C` | Focus rings, rules, large display accents only |
| `--brass-d` | `#7E5B1E` | Small accent text: eyebrows, labels |
| `--harbor` | `#1E5B55` | Money in, "allowed", settled |
| `--sea` | `#E3EEEA` | Tint behind harbor states |
| `--signal` | `#A3372A` | Denied, owes, errors |
| `--blush` | `#F6E7E2` | Tint behind signal states |

Contrast, measured with the WCAG formula (script in the build log, not estimated): ink on deck
14.2:1, ink on sheet 16.1:1, fog on deck 5.5:1, fog on sheet 6.2:1, brass-d on sheet 6.1:1 and
on deck 5.4:1, harbor on sheet 7.7:1 and on sea 6.6:1, signal on sheet 6.6:1 and on blush 5.6:1,
sheet on ink 16.1:1, brass on night 4.7:1, brass on ink 4.3:1. **Plain brass on sheet is only
3.8:1**, so it never carries small text on light surfaces; brass-d does.

Verdict colours are fixed and always paired with a word (never colour alone):
allowed = harbor on sea, needs approval = brass-d on `#F7EEDC`, denied = signal on blush.

## Type

- **Display: Fraunces** (variable, opsz 9-144, weight 300-700), SIL OFL 1.1, self-hosted from
  `web/public/fonts/fraunces-var.woff2`, licence in `web/public/fonts/OFL-Fraunces.txt`.
  Event titles, big money figures, section heads. Weight 500, tight tracking (-0.01em to
  -0.02em), optical size follows font size.
- **UI: IBM Plex Sans** (variable), SIL OFL 1.1, `web/public/fonts/plex-sans-var.woff2`,
  licence in `web/public/fonts/OFL-IBMPlexSans.txt`. Everything else, always with
  `font-variant-numeric: tabular-nums` so amounts line up in columns.
- Eyebrows: Plex Sans 600, 11-12px, 0.18-0.24em tracking, uppercase, brass-d.
- PayPal ids (order, capture, invoice, batch) are set in Plex Sans 500 at 12px with 0.02em
  tracking, never in a third typeface.

Scale (px): 12, 13, 14, 16, 18, 22, 28, 36, 48, 64 (video only: 88, 120).

## Space, shape, depth

- 4px base; spacing steps 4, 8, 12, 16, 24, 32, 48, 64.
- Radius: 8 (chips, inputs), 12 (cards), 999 (pills).
- One shadow: `0 1px 0 rgba(19,33,46,.04), 0 18px 40px -24px rgba(19,33,46,.25)`. Grids and
  the rail have no shadow.
- Ledger rules: 1px dashed `--rule` between rows of money, solid between sections.

## Icons

Lucide (ISC licence), 1.6px stroke, 16 or 20px, currentColor, inlined in
`web/src/icons.tsx`. One family only. The Purser mark is a purse drawn in the same stroke.

## Motion

- 160-240ms, `cubic-bezier(.2,.7,.2,1)` for entrances, linear for progress.
- Trace steps slide in 6px from below; grid cells flash harbor-tint for 600ms when PayPal
  changes them (AG Grid cell change flash, recoloured).
- Everything respects `prefers-reduced-motion`: animations collapse to opacity only.

## Illustration and imagery

- Style: **two-ink risograph prints** - navy (#13212E) and brass (#A87A2C) on cream paper
  (#F3EFE6), visible paper grain, slight misregistration, flat shapes, no gradients, no
  glossy 3D, no text in the image. Subjects: the trip itself (a cabin by a lake, a canoe, a
  pontoon boat at a jetty, a table set for eight, a kayak line), never money, coins, robots
  or glowing brains.
- People, when they appear, are small figures in the landscape; no faces in close-up.
- Generated with Google Flow (Nano Banana Pro) and logged in `design/GENERATED_ASSETS.md`;
  colour-graded to the two inks with `design/grade.py` so every image shares one palette.
- Product UI in the video and on Devpost is always a real capture of the running app.

## Accessibility

- Text contrast at least 4.5:1 (measured above), focus visible everywhere (3px brass ring,
  3px offset), every verdict carries a word as well as a colour, grid keyboard navigation is
  AG Grid's own, live trace region is `aria-live="polite"`.
