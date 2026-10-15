# Demo video: script and storyboard

Target **2:30** (hard limit under 3:00), 1920x1080, 30 fps, English narration (Edge neural
TTS, `en-US-AndrewMultilingualNeural` or `en-US-AvaMultilingualNeural`), burned-in captions,
music synthesised in code. Built with HyperFrames in `video/hyperframes/` from **real
captures of the running app** (`scripts/capture.py` stills at 1.5x, plus a screen recording
of the same flow) wrapped in motion graphics. Risograph art only as mood (opening, scene
breaks, end card). No Veo, no generated UI. End card: "Purser" + "Rui Codex".

Status (2026-10-15): script, storyboard, art and captures are ready; the HyperFrames build
and render are deferred to after 2026-10-20 (Claude weekly usage reset). Preferably re-shoot
the captures in **live sandbox mode** once the owner has created the sandbox app, so the
approval page in the video is PayPal's real sandbox checkout.

| # | Time | Picture | Narration |
| --- | --- | --- | --- |
| 1 | 0:00-0:12 | `hero-wide` art, slow push; title "Purser" types in; sub "the AI treasurer for group events" | Every group trip has a treasurer. They front the cabin, chase eight friends for their share, pay the boat rental, and work out what the friend who dropped out gets back. |
| 2 | 0:12-0:24 | Home screen capture; kinetic line "What if an agent did it, and you could audit every move?" | Purser is an agent that does that job through PayPal. The difference is that it can only do what the ledger says is owed. |
| 3 | 0:24-0:42 | Brief typed into the new-event screen -> draft budget (03-draft) with callouts on "Maya paid", "4 opted in", "owed to Lakeside Rentals", "sponsor" | You describe the trip the way you would in the group chat. Gemini reads it into a ledger: who is coming, who already paid for what, which business still has to be paid, and the sponsor. Every name it returns must appear in the brief. |
| 4 | 0:42-1:05 | Run the treasurer: trace panel fills (05-after-run); callouts on `create_order` x6 "PayPal Agent Toolkit", invoice created and sent, payouts "waiting for money" | The treasurer works through the PayPal Agent Toolkit. One order per person for their exact share, with a personal pay link. An invoice to the sponsor. And the reimbursements wait, because the pot is still empty. |
| 5 | 1:05-1:25 | Pay page (06) -> checkout (07, sandbox) -> paid (08) -> organizer ledger cells flash (09) | Priya opens her link, sees exactly what she is paying for, and pays with PayPal. The capture is confirmed by a webhook, and the organizer's ledger updates live. |
| 6 | 1:25-1:50 | Rogue-call montage: denied chips; text "amount must match the ledger to the cent", "only people the ledger owes", "never spend money that has not arrived", "big moves wait for you" | Every money move is checked in plain code before it reaches PayPal. An order must match the ledger to the cent. Money only goes to people the ledger owes. It never leaves the pot before it has arrived. And large payouts wait for the organizer. When the model gets it wrong, it is told why, and corrects itself. |
| 7 | 1:50-2:05 | All paid (10) -> treasurer run (11): Jonah reimbursed automatically, Maya's $1,248.50 in the approval inbox -> approve (12) | Once the money is in, Jonah's groceries are paid back automatically. Maya's cabin reimbursement is above the limit, so it waits for one click. |
| 8 | 2:05-2:20 | Kofi drops out (13): refund on his capture, $185 non-refundable cabin stays his, others re-asked $6.64 | Kofi can't make it. He keeps his share of the non-refundable cabin, the rest is refunded on the payment he made, and everyone else is asked for the difference, to the cent. |
| 9 | 2:20-2:30 | Ask the ledger (14) -> PayPal objects grid (17) -> end card (`cabin` art, "Purser", "PayPal sandbox + Agent Toolkit + Gemini + AG Grid", "Rui Codex") | Ask the ledger anything in plain English. Purser: the treasurer you can trust with the trip money. |

Word count of the narration: about 330 words, about 2:20 at a natural pace.
