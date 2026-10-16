# Publish checklist: Purser (PayPal AI Hackathon)

- **Deadline:** Thursday 2026-11-12, 12:00 PT = **21:00 Belgian time (CET)**. Target: submitted
  by 2026-11-08.
- **Requirements (official rules, re-read 2026-10-15):** PayPal developer platform in the free
  sandbox + any AI; text description; functional demo (run instructions in the repo **or**
  a hosted URL); list of AI tools used; **public** GitHub/GitLab/Bitbucket repo with an open
  source licence visible in the About panel; YouTube video under 3 minutes, public, showing
  the project working, no third-party copyrighted music.
- Every publish, upload and submit step below needs the owner's separate approval.

## Published 2026-10-16 (owner said "hepsini yap")

- Repo: https://github.com/RuiCodex-dev/purser (public, MIT detected)
- Video: https://youtu.be/3e2EhTpMcA0 (public, @RuiCodex)
- Demo: https://purser.ruicodex.com (no-keys mode)
- Devpost: see section 5 below

## Status 2026-10-16 (RUI-219)

- Sandbox app exists; keys in `C:/Users/Admin/.ruicodex-keys/purser.env.json`. Live checks:
  28/28 (`scripts/live-e2e.ts`, `docs/sandbox-evidence/e2e-phase1-*.json`).
- 25/25 offline tests; clean `npm ci` + build + typecheck; gitleaks over the full history: no
  leaks; author/committer on every commit is the GitHub noreply identity.
- Video rendered: `video/purser-demo.mp4` + `video/purser-demo.en.srt` (upload text in
  `video/YOUTUBE.md`).
- Devpost **draft** created and filled (not submitted):
  https://devpost.com/submit-to/31302-paypal-ai-hackathon/manage/submissions/1240493-purser/project-overview
- QA record: `qa/QA-2026-10-16.md`.

## 0. Owner: optional, finishes the live evidence

- [ ] Phase 2 of the live run needs one sandbox buyer payment: start Purser live, open two
      participants' pay links, log in as the sandbox personal account
      (sb-oohr853374521@personal.example.com; its password is shown only in the developer
      dashboard > Testing Tools > Sandbox Accounts) and pay; then
      `node scripts/live-e2e.ts --continue <event id>` checks captures, idempotent re-capture
      and the drop-out refund in the sandbox. Alternatively put the sandbox buyer password in
      the keys file and an agent can do it.

## 1. Before any publish

- [x] `npm ci && npm run build && npm test` passes (25 tests).
- [x] Secret scan clean (`npm run secret-scan` + gitleaks over the full history).
- [x] `data/`, `qa/run-data-*`, `.env`, `design/gen/`, `video/work/`, `video/hyperframes/assets/clips/`,
      `video/hyperframes/assets/mix.wav` and rendered MP4s are git-ignored.
- [x] Commit author is `Selman Altinay <88661900+altinayselman@users.noreply.github.com>`.

## 2. Publish the repository (owner approval A)

```sh
gh repo create purser --public --source . --remote origin --push \
  --description "Purser: the AI treasurer for group events - PayPal Agent Toolkit + Gemini, with a mandate the agent can't break"
gh repo edit --add-topic paypal,agent-toolkit,ai-agent,gemini,ag-grid,hackathon
```

GitHub detects `LICENSE` (MIT) and shows it in the About panel, as the rules require.

## 3. Video (owner approval B for the YouTube upload)

- [x] Built and rendered with HyperFrames (`video/README.md`).
- [ ] Watch it once end to end: under 3:00, no key fields or secrets on screen, music is
      our own, captions readable.
- [ ] Upload to YouTube **public** (not unlisted), title "Purser - the AI treasurer for group
      events (PayPal AI Hackathon)", description from `DEVPOST.md` first paragraph + repo link.

## 4. Optional hosted demo (owner approval C) - plan in `docs/HOSTING_PLAN.md`

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
