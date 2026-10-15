import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

// Settings come from the environment. Two optional conveniences, neither of
// which is ever committed: a `.env` file in the project root, and
// PURSER_SECRETS_FILE pointing at a JSON object of the same variable names
// kept outside the repository.

function loadDotEnv(file: string): Record<string, string> {
  if (!existsSync(file)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

function loadSecretsFile(path?: string): Record<string, string> {
  if (!path || !existsSync(path)) return {};
  const j = JSON.parse(readFileSync(path, "utf8"));
  return Object.fromEntries(Object.entries(j).filter(([, v]) => typeof v === "string")) as Record<string, string>;
}

export interface Config {
  port: number;
  host: string;
  publicBase: string;
  dataDir?: string;
  paypal?: { clientId: string; clientSecret: string; webhookId?: string };
  forceFixtures: boolean;
  gemini: { apiKey?: string; model: string; fallbackModels: string[] };
  fixtureSettleMs: number;
}

export function loadConfig(root = process.cwd(), env: NodeJS.ProcessEnv = process.env): Config {
  const merged: Record<string, string | undefined> = {
    ...loadDotEnv(resolve(root, ".env")),
    ...loadSecretsFile(env.PURSER_SECRETS_FILE),
    ...env,
  };
  const port = Number(merged.PORT ?? 8790);
  const id = merged.PAYPAL_CLIENT_ID?.trim();
  const secret = merged.PAYPAL_CLIENT_SECRET?.trim();
  return {
    port,
    host: merged.HOST ?? "127.0.0.1",
    publicBase: (merged.PUBLIC_BASE_URL ?? `http://localhost:${port}`).replace(/\/$/, ""),
    dataDir: merged.PURSER_DATA_DIR === "memory" ? undefined : resolve(root, merged.PURSER_DATA_DIR ?? "data"),
    paypal: id && secret ? { clientId: id, clientSecret: secret, webhookId: merged.PAYPAL_WEBHOOK_ID?.trim() || undefined } : undefined,
    forceFixtures: merged.PURSER_PAYPAL_MODE === "fixtures",
    gemini: {
      apiKey: merged.GEMINI_API_KEY?.trim() || undefined,
      model: merged.GEMINI_MODEL ?? "gemini-3.5-flash",
      fallbackModels: (merged.GEMINI_FALLBACK_MODELS ?? "gemini-3.1-flash-lite,gemini-3.5-flash-lite").split(",").map((s) => s.trim()).filter(Boolean),
    },
    fixtureSettleMs: Number(merged.PURSER_FIXTURE_SETTLE_MS ?? 1500),
  };
}
