// Scans every file git would publish (tracked + untracked, minus .gitignore)
// for credential patterns and for the literal values of any secrets this
// machine has configured. Prints file:line and the rule, never the value.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { loadConfig } from "../server/config.ts";

const PATTERNS: [string, RegExp][] = [
  ["Google API key", /AIza[0-9A-Za-z_-]{35}/],
  ["OpenAI-style key", /\bsk-[A-Za-z0-9_-]{20,}/],
  ["Private key block", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["PayPal access token", /\bA21AA[A-Za-z0-9_-]{40,}/],
  ["Bearer token literal", /Bearer\s+[A-Za-z0-9._-]{30,}/],
  ["client_secret assignment", /client_?secret["']?\s*[:=]\s*["'][A-Za-z0-9_-]{30,}["']/i],
  ["Webhook/basic auth in URL", /https?:\/\/[^\s/:@]+:[^\s/@]{8,}@/],
];

const cfg = loadConfig();
const literals = [cfg.paypal?.clientSecret, cfg.paypal?.clientId, cfg.gemini.apiKey].filter((v): v is string => Boolean(v && v.length >= 12));

const files = execFileSync("git", ["ls-files", "-co", "--exclude-standard"], { encoding: "utf8" })
  .split("\n")
  .filter(Boolean)
  .filter((f) => existsSync(f) && statSync(f).size < 2_000_000 && !/\.(png|jpe?g|webp|woff2?|mp4|mp3|wav|ico|gif)$/i.test(f));

let hits = 0;
for (const f of files) {
  const lines = readFileSync(f, "utf8").split("\n");
  lines.forEach((line, i) => {
    for (const [name, re] of PATTERNS) if (re.test(line) && !line.includes("secret-scan: allow")) {
      console.log(`${f}:${i + 1}  ${name}`);
      hits++;
    }
    for (const v of literals) if (line.includes(v)) {
      console.log(`${f}:${i + 1}  configured secret value`);
      hits++;
    }
  });
}
console.log(`secret-scan: ${files.length} files, ${literals.length} configured secret(s) checked, ${hits} finding(s)`);
process.exit(hits ? 1 : 0);
