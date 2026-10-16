# Demo video

`purser-demo.mp4` (1920x1080, 30 fps, about 2:23) is built with HyperFrames from real
recordings of the running app. Large binaries (the MP4, the recordings and the audio mix)
are git-ignored; this folder holds everything needed to rebuild them.

1. Start two Purser servers: one live (`PURSER_SECRETS_FILE=<keys json> PORT=8790 npm start`,
   PayPal sandbox + Gemini) and one in the no-keys mode
   (`PURSER_PAYPAL_MODE=fixtures PORT=8791 PUBLIC_BASE_URL=http://localhost:8791 npm start`).
2. Record (Chrome DevTools screencast, real speed, frame timestamps kept):
   `python scripts/record_demo.py http://localhost:8790 http://localhost:8791 video/work/rec`,
   then copy `video/work/rec/*.mp4` into `video/hyperframes/assets/clips/`.
   The live clip stops on PayPal's sandbox sign-in page; nothing is typed into PayPal.
3. Mandate scene: `node scripts/rogue-demo.ts > video/work/rogue.txt` (real output).
4. Narration, music and captions: `python video/make_audio.py` (Edge neural TTS
   `en-US-AndrewMultilingualNeural`; music synthesised in code; ducked pre-mix; writes
   `purser-demo.en.srt` and `timings.json`).
5. Composition: `python video/build_composition.py` (writes `hyperframes/index.html`).
6. Check and render: `cd video/hyperframes && npx hyperframes@0.8.164 check && npx hyperframes@0.8.164 render -o ../purser-demo.mp4 -q delivery`.

What is on screen, honestly labelled in the video:

- **Live** (PayPal sandbox + Gemini): the brief read by Gemini, the treasurer creating real
  sandbox orders and the sponsor invoice through the PayPal Agent Toolkit, a pay link
  landing on PayPal's own sandbox checkout.
- **No-keys demo mode** (offline fixtures of the sandbox contracts): buyer approval in the
  labelled checkout simulator, live ledger update, payouts and the approval inbox, the
  drop-out refund, ask-the-ledger. Approving a real sandbox checkout needs the sandbox
  buyer's password, which only the owner can see; see `docs/sandbox-evidence/` for the live
  API evidence of the same flows.
- Speed-ups are labelled (1.5x to 4x). No Veo or other generated video; the only generated
  imagery is the risograph art logged in `design/GENERATED_ASSETS.md`.
