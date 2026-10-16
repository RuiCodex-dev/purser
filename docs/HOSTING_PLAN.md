# Hosted demo plan (not deployed; needs the owner's approval)

The official rules do **not** require a hosted demo: "Your project does not need to be
publicly hosted or deployed - but judges must be able to actually run or interact with a
working build. This can be satisfied through clear, complete setup and run instructions in
your code repository ... OR a hosted demo URL." Purser already satisfies the first route:
`npm ci && npm run build && npm start` runs end to end with no keys.

A hosted demo is still worth having for judges who will not clone a repo, and it helps the
"Best Demo Delivery" prize. This is the plan, following the same pattern as Hostwise
(`hostwise.ruicodex.com`): a Docker container on the owner's own server behind nginx and
IIS, with a Let's Encrypt certificate.

## Target

- URL: `https://purser.ruicodex.com` (new DNS A/CNAME record to the owner's server).
- Container: the repository's `Dockerfile` (Node 22.18, one process, `/api/health`
  health check, data in a `/data` volume, runs as the `node` user).
- Reverse proxy: IIS site binding for `purser.ruicodex.com` -> ARR/URL Rewrite -> nginx or
  directly -> `http://127.0.0.1:8790`. **Server-Sent Events must not be buffered**:
  `/api/stream` needs response buffering off (nginx `proxy_buffering off;`, IIS ARR
  `responseBufferLimit="0"`), or live ledger updates arrive late.
- TLS: Let's Encrypt (win-acme on IIS, as for the other subdomains).

## Which mode to host (owner's decision)

| Option | What judges get | Risk | Recommendation |
| --- | --- | --- | --- |
| **A. Offline fixtures, public** (`PURSER_PAYPAL_MODE=fixtures`, no Gemini key) | The full flow incl. the labelled checkout simulator, drop-out refunds, approvals; deterministic treasurer | None: no keys on the server, nothing reaches PayPal or Google | **Default** |
| B. Live sandbox behind a login | Real PayPal sandbox orders, invoices, payouts, the real sandbox checkout page, Gemini | Sandbox only (no real money), but anyone with the login spends the Gemini free-tier quota and fills the sandbox account | Only with HTTP basic auth on the proxy; credentials in the Devpost "testing instructions" field (allowed by the rules: "If Entrant's website is private, Entrant must include login credentials") |

The organizer UI has no accounts by design (a hackathon build), so a public live instance
must not be exposed without option B's login.

## Configuration

```sh
docker build -t purser .
# Option A
docker run -d --name purser --restart unless-stopped -p 127.0.0.1:8790:8790 \
  -e PURSER_PAYPAL_MODE=fixtures -e PUBLIC_BASE_URL=https://purser.ruicodex.com \
  -v purser-data:/data purser
# Option B: same, plus --env-file pointing at a file OUTSIDE the repo with
#   PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, GEMINI_API_KEY (and PAYPAL_WEBHOOK_ID, below)
```

- `PUBLIC_BASE_URL` must be the public https URL: PayPal sends payers back to it.
- Option B webhooks: in the PayPal developer dashboard (sandbox app "Purser") add the
  webhook `https://purser.ruicodex.com/api/webhooks/paypal` for `CHECKOUT.ORDER.APPROVED`,
  `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.CAPTURE.REFUNDED`, `INVOICING.INVOICE.PAID`,
  `PAYMENT.PAYOUTSBATCH.SUCCESS`, `PAYMENT.PAYOUTS-ITEM.SUCCEEDED`; put the Webhook ID in
  `PAYPAL_WEBHOOK_ID`. Signature verification is then on (`/api/health` shows it).
- Reset: a nightly `docker restart purser` after deleting the volume's `purser.json` keeps
  the demo clean (`docker exec purser rm -f /data/purser.json && docker restart purser`).

## After deploying (checklist)

- [ ] `https://purser.ruicodex.com/api/health` -> 200, expected `paypal.mode`.
- [ ] New event > Skip to the demo event > Run the treasurer; open a pay link, pay, see the
      ledger update live (proves SSE passes the proxy unbuffered).
- [ ] No key in page source, responses or logs (`/api/health` reports only modes).
- [ ] Add the URL to `DEVPOST.md` ("Try it out") and the README.

Nothing in this file has been executed. Deploying needs the owner's explicit approval
(approval C in `PUBLISH_CHECKLIST.md`).
