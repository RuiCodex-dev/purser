// Minimal Gemini client over REST (no SDK): text, JSON-schema output, images
// and function calling. Any failure is reported, never thrown past the caller
// that asked for a fallback.

export interface GeminiConfig {
  apiKey?: string;
  model: string;
  fallbackModels: string[];
  timeoutMs?: number;
}

export type Part =
  | { text: string; thoughtSignature?: string }
  | { inlineData: { mimeType: string; data: string } }
  | { functionCall: { id?: string; name: string; args: Record<string, unknown> }; thoughtSignature?: string }
  | { functionResponse: { id?: string; name: string; response: Record<string, unknown> } };

export interface Content {
  role: "user" | "model";
  parts: Part[];
}

export interface FunctionDecl {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface GenerateRequest {
  system?: string;
  contents: Content[];
  tools?: FunctionDecl[];
  schema?: Record<string, unknown>;
  temperature?: number;
}

export interface GenerateResult {
  ok: boolean;
  model?: string;
  content?: Content;
  text?: string;
  calls: { id?: string; name: string; args: Record<string, unknown> }[];
  error?: string;
}

export class Gemini {
  private cfg: GeminiConfig;
  constructor(cfg: GeminiConfig) {
    this.cfg = cfg;
  }

  get available(): boolean {
    return Boolean(this.cfg.apiKey);
  }

  get model(): string {
    return this.cfg.model;
  }

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    if (!this.cfg.apiKey) return { ok: false, calls: [], error: "No GEMINI_API_KEY configured" };
    const body: Record<string, unknown> = {
      contents: req.contents,
      generationConfig: {
        temperature: req.temperature ?? 0.2,
        ...(req.schema ? { responseMimeType: "application/json", responseSchema: req.schema } : {}),
      },
    };
    if (req.system) body.systemInstruction = { parts: [{ text: req.system }] };
    if (req.tools?.length) body.tools = [{ functionDeclarations: req.tools }];

    const errors: string[] = [];
    let lastError = "";
    for (const model of [this.cfg.model, ...this.cfg.fallbackModels]) {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-goog-api-key": this.cfg.apiKey },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(this.cfg.timeoutMs ?? 30_000),
          });
          if (res.status === 429 || res.status >= 500) {
            lastError = `${model}: HTTP ${res.status}`;
            await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
            continue;
          }
          const j: any = await res.json();
          if (!res.ok) {
            lastError = `${model}: ${String(j?.error?.message ?? `HTTP ${res.status}`).slice(0, 140)}`;
            break; // a 4xx will not improve on retry; try the next model
          }
          const content: Content | undefined = j.candidates?.[0]?.content;
          if (!content?.parts) {
            lastError = `${model}: empty response (${j.candidates?.[0]?.finishReason ?? "no candidate"})`;
            break;
          }
          const text = content.parts
            .filter((p: any) => typeof p.text === "string" && !p.thought)
            .map((p: any) => p.text)
            .join("");
          const calls = content.parts.filter((p: any) => p.functionCall).map((p: any) => ({ id: p.functionCall.id, name: p.functionCall.name, args: p.functionCall.args ?? {} }));
          return { ok: true, model, content: { role: "model", parts: content.parts }, text, calls };
        } catch (e) {
          lastError = `${model}: ${(e as Error).name === "TimeoutError" ? "timeout" : (e as Error).message}`;
          if ((e as Error).name === "TimeoutError") break;
        }
      }
      errors.push(lastError);
    }
    return { ok: false, calls: [], error: errors.length ? errors.join(" | ") : lastError };
  }

  async json<T>(req: GenerateRequest): Promise<{ ok: true; value: T; model: string } | { ok: false; error: string }> {
    const r = await this.generate(req);
    if (!r.ok || !r.text) return { ok: false, error: r.error ?? "empty" };
    try {
      return { ok: true, value: JSON.parse(r.text) as T, model: r.model! };
    } catch {
      return { ok: false, error: "Model returned invalid JSON" };
    }
  }
}

/**
 * Gemini's function declarations accept an OpenAPI subset. The Agent Toolkit
 * publishes full JSON Schema, so strip what Gemini rejects and fold nullable
 * unions.
 */
export function toGeminiSchema(s: any): any {
  if (Array.isArray(s)) return s.map(toGeminiSchema);
  if (!s || typeof s !== "object") return s;
  if (s.anyOf) {
    const opts = (s.anyOf as any[]).filter((o) => o && o.type !== "null" && !("not" in o));
    const flat = opts.flatMap((o) => (o.anyOf ? (o.anyOf as any[]).filter((x) => x && x.type !== "null" && !("not" in x)) : [o]));
    const pick = flat[0] ?? { type: "string" };
    return toGeminiSchema({ ...pick, description: s.description ?? pick.description });
  }
  const out: any = {};
  for (const [k, v] of Object.entries(s)) {
    if (["$schema", "additionalProperties", "default", "pattern", "minLength", "maxLength", "not"].includes(k)) continue;
    if (k === "properties") {
      out.properties = Object.fromEntries(Object.entries(v as object).map(([pk, pv]) => [pk, toGeminiSchema(pv)]));
    } else if (k === "items") out.items = toGeminiSchema(v);
    else out[k] = v;
  }
  if (out.type === "object" && !out.properties) out.properties = {};
  return out;
}
