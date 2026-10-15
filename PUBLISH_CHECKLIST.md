# Publish checklist: Purser (PayPal AI Hackathon)

- **Deadline:** Thursday 2026-11-12, 12:00 PT = **21:00 Belgian time (CET)**. Target: submitted
  by 2026-11-08.
- **Requirements (official rules, re-read 2026-10-15):** PayPal developer platform in the free
  sandbox + any AI; text description; functional demo (run instructions in the repo **or**
  a hosted URL); list of AI tools used; **public** GitHub/GitLab/Bitbucket repo with an open
  source licence visible in the About panel; YouTube video under 3 minutes, public, showing
  the project working, no third-party copyrighted music.
- Every publish, upload and submit step below needs the owner's separate approval.

## 0. Owner: PayPal sandbox (blocks live evidence, not the submission)

- [ ] Sign in at https://developer.paypal.com/dashboard/ (existing account, info@ruicodex.com)
      and follow `docs/SANDBOX_SETUP.md` (create the sandbox app "Purser", tick Invoicing and
      Payouts, note the sandbox personal account).
- [ ] Put the Client ID and Secret in `C:\Users\Admin\.ruicodex-keys\purser.env.json`
      (`PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`) - never in the repo. An agent can then run
      `scripts/sandbox-check.ts`, the live flow in the app, and re-shoot captures in live mode.

## 1. Before any publish

- [ ] `npm ci && npm run build && npm test` passes (16 tests).
- [ ] `PURSER_SECRETS_FILE=C:/Users/Admin/.ruicodex-keys/purser.env.json npm run secret-scan`
      reports 0 findings (checks every file git would publish, plus the literal key values).
- [ ] `git log -p | findstr /i "AIza A21AA client_secret"` shows nothing but code.
- [ ] `data/`, `.env`, `design/gen/`, `video/work/` and rendered MP4s are git-ignored
      (`git ls-files data design/gen video/work` prints nothing).
- [ ] Live sandbox evidence committed in `docs/sandbox-evidence/` (ids and debug ids only).

## 2. Publish the repository (owner approval A)

```sh
gh repo create purser --public --source . --remote origin --push \
  --description "Purser: the AI treasurer for group events - PayPal Agent Toolkit + Gemini, with a mandate the agent can't break"
gh repo edit --add-topic paypal,agent-toolkit,ai-agent,gemini,ag-grid,hackathon
```

GitHub detects `LICENSE` (MIT) and shows it in the About panel, as the rules require.

## 3. Video (owner approval B for the YouTube upload)

- [ ] Build and render per `video/SCRIPT.md` (HyperFrames, deferred to after 2026-10-20).
- [ ] Watch it once end to end: under 3:00, no key fields or secrets on screen, music is
      our own, captions readable.
- [ ] Upload to YouTube **public** (not unlisted), title "Purser - the AI treasurer for group
      events (PayPal AI Hackathon)", description from `DEVPOST.md` first paragraph + repo link.

## 4. Optional hosted demo (owner approval C)

Not required: the rules accept run instructions, and Purser runs with no keys. If wanted,
the `Dockerfile` runs as-is behind any reverse proxy (`PUBLIC_BASE_URL` must be the public
URL). Note the organizer UI has no login, so a public instance should run in offline
fixture mode or behind access control, and be reset regularly.

## 5. Devpost submission (owner approval D)

- [ ] On https://paypalaihackathon.devpost.com/ > Enter a submission; paste from
      `DEVPOST.md`. Fill repo URL, YouTube URL, "Built with" tags, AI tools field.
- [ ] Images: `docs/screenshots/event.png` (cover), `first-run.png`, `pay-page.png`,
      `drop-out-refund.png`, `ask-the-ledger.png`, `paypal-objects.png`; optionally the
      risograph `design/art/hero-wide.png` as a gallery image.
- [ ] Submitter type: individual (Selman Altinay) or organisation "Rui Codex" - owner's
      choice; company field "Rui Codex".
- [ ] Do not link a GitHub account to Devpost unless the owner approves it.
- [ ] Sponsor prize opt-ins: AG Grid (uses AG Grid Community). Also eligible for "Best Use of
      PayPal + AI" and "Best Use of Agentic Commerce" (all eligible submissions).
- [ ] Submit before 2026-11-12 21:00 CET; screenshot the confirmation.

Prize money, if any, is professional income of the eenmanszaak (note only).
