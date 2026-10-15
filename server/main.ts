import { createApp } from "./app.ts";
import { loadConfig } from "./config.ts";

const cfg = loadConfig();
const app = createApp(cfg);
const d = app.pp.describe();

app.server.listen(cfg.port, cfg.host, () => {
  console.log(`Purser is running at ${cfg.publicBase}`);
  console.log(`  PayPal: ${d.mode} via @paypal/agent-toolkit ${d.toolkitVersion}${cfg.paypal?.webhookId ? " (webhook verification on)" : ""}`);
  console.log(`  AI:     ${app.llm.available ? `Gemini (${app.llm.model})` : "no model key - deterministic treasurer and offline parser"}`);
});

let closing = false;
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    if (closing) return;
    closing = true;
    await app.close();
    process.exit(0);
  });
}
