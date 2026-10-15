# Connecting Purser to the PayPal sandbox

Ten minutes, once. Everything here happens in the **sandbox**; no real money moves.

1. Sign in at https://developer.paypal.com/dashboard/ (an existing PayPal account works).
2. **Apps & Credentials** > make sure the toggle says **Sandbox** > **Create App**.
   - Name: `Purser`; type: Merchant; sandbox business account: the default one.
   - Copy the **Client ID** and **Secret**.
3. In the same app, **Features**: make sure **Invoicing** and **Payouts** are ticked
   (Payouts may need a moment to activate on new sandbox apps).
4. **Testing Tools > Sandbox Accounts**: note the email of the default **Personal** sandbox
   account (and open it to see its generated password). This is the "buyer" you log in as
   on the PayPal approval page.
5. Put the credentials where Purser reads them - never in the repository:
   - either a `.env` in the project root (git-ignored), or
   - a JSON file outside the repo and `PURSER_SECRETS_FILE=<path>`:
     ```json
     { "PAYPAL_CLIENT_ID": "...", "PAYPAL_CLIENT_SECRET": "...", "GEMINI_API_KEY": "..." }
     ```
6. Check everything with `node scripts/sandbox-check.ts`
   (set `SANDBOX_PAYOUT_EMAIL` to the personal sandbox email so the test payout is claimed).
   Open the printed approval link, log in as the sandbox personal account, approve, then run
   `node scripts/sandbox-check.ts --capture <order id>` and
   `node scripts/sandbox-check.ts --refund <capture id>`. Evidence lands in
   `docs/sandbox-evidence/`.
7. Optional, for live webhooks: expose the app publicly (a tunnel or the hosted demo), set
   `PUBLIC_BASE_URL` to that URL, then in the app's **Webhooks** section add
   `<PUBLIC_BASE_URL>/api/webhooks/paypal` with the events `CHECKOUT.ORDER.APPROVED`,
   `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.CAPTURE.REFUNDED`, `INVOICING.INVOICE.PAID`,
   `PAYMENT.PAYOUTSBATCH.SUCCESS`, `PAYMENT.PAYOUTS-ITEM.SUCCEEDED` (or "All events"), and
   copy the **Webhook ID** into `PAYPAL_WEBHOOK_ID`. Without webhooks, the
   **Reconcile with PayPal** button pulls the same state.

Then `npm start`: the app's status line reads "PayPal sandbox, live".
