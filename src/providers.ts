import type { ModelClient } from "./llm.js";

/**
 * Model providers.
 *
 * The repair loop only ever needs one thing from a model: text in, text out.
 * Keeping that interface one method wide means supporting a new provider is a
 * request shape and a response path, not an integration — and it means a local
 * model on a laptop is a first-class option rather than a downgrade.
 *
 * Nothing here is required. Heuristics repair most breaks with no model at all;
 * this is the fallback for the ones they cannot see.
 */

export type Provider = "anthropic" | "openai" | "gemini" | "ollama";

export interface ModelConfig {
  /** Omit to infer from whichever API key is present in the environment. */
  provider?: Provider;
  model?: string;
  /** Override for a compatible gateway, proxy or local server. */
  baseUrl?: string;
  /** Environment variable holding the key. Never the key itself. */
  apiKeyEnv?: string;
  maxTokens?: number;
  timeoutMs?: number;
  /** Attempts on a retryable failure, beyond the first. Default 2. */
  retries?: number;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryable = false,
  ) {
    super(message);
  }
}

const DEFAULT_MODEL: Record<Provider, string> = {
  anthropic: "claude-sonnet-5",
  openai: "gpt-4o-mini",
  gemini: "gemini-2.0-flash",
  ollama: "llama3.1",
};

const DEFAULT_BASE: Record<Provider, string> = {
  anthropic: "https://api.anthropic.com",
  openai: "https://api.openai.com/v1",
  gemini: "https://generativelanguage.googleapis.com",
  ollama: "http://127.0.0.1:11434",
};

/** Environment variables consulted per provider, in order. */
export const KEY_VARS: Record<Provider, string[]> = {
  anthropic: ["ANTHROPIC_API_KEY"],
  openai: ["OPENAI_API_KEY"],
  gemini: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
  ollama: [],
};

/** Providers whose base url can be pointed at anything OpenAI-shaped. */
export const OPENAI_COMPATIBLE_NOTE =
  'Any OpenAI-compatible endpoint works with provider "openai": set baseUrl to ' +
  "Groq, Together, OpenRouter, vLLM, LM Studio or llama.cpp and it behaves the same.";

export function detectProvider(env: NodeJS.ProcessEnv = process.env): Provider | null {
  if (env["MENDER_PROVIDER"]) {
    const p = env["MENDER_PROVIDER"].toLowerCase() as Provider;
    if (p in DEFAULT_MODEL) return p;
  }
  for (const provider of ["anthropic", "openai", "gemini"] as const) {
    if (KEY_VARS[provider].some((v) => env[v])) return provider;
  }
  // Ollama needs no key, so it is only chosen when explicitly pointed at.
  if (env["OLLAMA_HOST"]) return "ollama";
  return null;
}

function apiKeyFor(
  provider: Provider,
  cfg: ModelConfig,
  env: NodeJS.ProcessEnv,
): string | null {
  const names = cfg.apiKeyEnv ? [cfg.apiKeyEnv] : KEY_VARS[provider];
  for (const n of names) {
    const v = env[n];
    if (v) return v;
  }
  return null;
}

interface Request {
  url: string;
  headers: Record<string, string>;
  body: unknown;
  /** Pull the assistant text out of a decoded response body. */
  read(json: unknown): string;
}

function buildRequest(
  provider: Provider,
  model: string,
  baseUrl: string,
  apiKey: string | null,
  system: string,
  user: string,
  maxTokens: number,
): Request {
  switch (provider) {
    case "anthropic":
      return {
        url: `${baseUrl}/v1/messages`,
        headers: {
          "x-api-key": apiKey ?? "",
          "anthropic-version": "2023-06-01",
        },
        body: { model, max_tokens: maxTokens, system, messages: [{ role: "user", content: user }] },
        read: (json) => {
          const b = json as { content?: { type: string; text?: string }[] };
          return (b.content ?? [])
            .filter((c) => c.type === "text")
            .map((c) => c.text ?? "")
            .join("");
        },
      };

    case "openai":
      return {
        url: `${baseUrl}/chat/completions`,
        headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
        body: {
          model,
          max_completion_tokens: maxTokens,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
        },
        read: (json) => {
          const b = json as { choices?: { message?: { content?: string } }[] };
          return b.choices?.[0]?.message?.content ?? "";
        },
      };

    case "gemini":
      return {
        // The key rides in a header rather than the query string, so it never
        // lands in a proxy log or an error message containing the URL.
        url: `${baseUrl}/v1beta/models/${model}:generateContent`,
        headers: apiKey ? { "x-goog-api-key": apiKey } : {},
        body: {
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: "user", parts: [{ text: user }] }],
          generationConfig: { maxOutputTokens: maxTokens, temperature: 0 },
        },
        read: (json) => {
          const b = json as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
          return (b.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "").join("");
        },
      };

    case "ollama":
      return {
        url: `${baseUrl}/api/chat`,
        headers: {},
        body: {
          model,
          stream: false,
          options: { num_predict: maxTokens, temperature: 0 },
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
        },
        read: (json) => {
          const b = json as { message?: { content?: string } };
          return b.message?.content ?? "";
        },
      };
  }
}

/** 429 and 5xx are worth another attempt; a 400 or a 401 never is. */
export function isRetryable(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

function backoffMs(attempt: number, retryAfter?: string | null): number {
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(30_000, seconds * 1000);
  }
  return Math.min(8000, 250 * 2 ** attempt);
}

export interface CreateOptions {
  env?: NodeJS.ProcessEnv;
  /** Test seam. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Build a client, or null when nothing is configured — a missing key is not an
 * error, it just means the heuristics work alone.
 */
export function createModelClient(
  cfg: ModelConfig = {},
  opts: CreateOptions = {},
): ModelClient | null {
  const env = opts.env ?? process.env;
  const provider = cfg.provider ?? detectProvider(env);
  if (!provider) return null;

  const apiKey = apiKeyFor(provider, cfg, env);
  // Ollama and other local servers legitimately have no key; hosted ones do not.
  if (!apiKey && provider !== "ollama") return null;

  const model = cfg.model ?? env["MENDER_MODEL"] ?? DEFAULT_MODEL[provider];
  const baseUrl = (cfg.baseUrl ?? env["MENDER_BASE_URL"] ?? DEFAULT_BASE[provider]).replace(/\/+$/, "");
  const maxTokens = cfg.maxTokens ?? 700;
  const timeoutMs = cfg.timeoutMs ?? 45_000;
  const retries = cfg.retries ?? 2;
  const doFetch = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  return {
    name: `${provider}:${model}`,
    async complete(req) {
      const built = buildRequest(
        provider,
        model,
        baseUrl,
        apiKey,
        req.system,
        req.user,
        req.maxTokens || maxTokens,
      );

      let lastError: ProviderError | null = null;

      for (let attempt = 0; attempt <= retries; attempt++) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const res = await doFetch(built.url, {
            method: "POST",
            signal: controller.signal,
            headers: { "content-type": "application/json", ...built.headers },
            body: JSON.stringify(built.body),
          });

          if (!res.ok) {
            const text = (await res.text()).slice(0, 300);
            const err = new ProviderError(
              `${provider} ${res.status}: ${text}`,
              res.status,
              isRetryable(res.status),
            );
            if (!err.retryable || attempt === retries) throw err;
            lastError = err;
            await sleep(backoffMs(attempt, res.headers.get("retry-after")));
            continue;
          }

          return built.read(await res.json());
        } catch (e) {
          if (e instanceof ProviderError) {
            if (!e.retryable || attempt === retries) throw e;
            lastError = e;
          } else {
            // A transport failure or a timeout is worth one more try.
            const err = new ProviderError(`${provider}: ${(e as Error).message}`, undefined, true);
            if (attempt === retries) throw err;
            lastError = err;
          }
          await sleep(backoffMs(attempt));
        } finally {
          clearTimeout(timer);
        }
      }

      throw lastError ?? new ProviderError(`${provider}: exhausted retries`);
    },
  };
}

/** What is configured right now, for `mender doctor` to report. */
export function describeModel(
  cfg: ModelConfig = {},
  env: NodeJS.ProcessEnv = process.env,
): { provider: Provider | null; model: string | null; hasKey: boolean; keyVar: string | null } {
  const provider = cfg.provider ?? detectProvider(env);
  if (!provider) return { provider: null, model: null, hasKey: false, keyVar: null };
  const names = cfg.apiKeyEnv ? [cfg.apiKeyEnv] : KEY_VARS[provider];
  const keyVar = names.find((n) => env[n]) ?? names[0] ?? null;
  return {
    provider,
    model: cfg.model ?? env["MENDER_MODEL"] ?? DEFAULT_MODEL[provider],
    hasKey: provider === "ollama" || names.some((n) => Boolean(env[n])),
    keyVar,
  };
}
