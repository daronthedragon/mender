import { eq, ok, section } from "./harness.mjs";
import {
  createModelClient,
  detectProvider,
  describeModel,
  isRetryable,
  ProviderError,
  KEY_VARS,
} from "../dist/providers.js";

section("model providers");

/** A fake fetch that records the request and returns a canned provider reply. */
function fakeFetch(reply, { status = 200, headers = {} } = {}) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const payload = typeof reply === "function" ? reply(calls.length) : reply;
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (k) => headers[k.toLowerCase()] ?? null },
      async json() {
        return payload;
      },
      async text() {
        return typeof payload === "string" ? payload : JSON.stringify(payload);
      },
    };
  };
  impl.calls = calls;
  return impl;
}

const ask = (client) => client.complete({ system: "SYS", user: "USER", maxTokens: 100 });

/* ---- each provider's request and response shape ---- */
{
  const f = fakeFetch({ content: [{ type: "text", text: "from claude" }] });
  const c = createModelClient({ provider: "anthropic" }, { env: { ANTHROPIC_API_KEY: "k" }, fetchImpl: f });
  eq(await ask(c), "from claude", "anthropic response is read");
  eq(c.name, "anthropic:claude-sonnet-5", "and the client names itself");
  ok(f.calls[0].url.endsWith("/v1/messages"), "posting to the messages endpoint");
  eq(f.calls[0].init.headers["x-api-key"], "k", "with the key as x-api-key");
  eq(f.calls[0].init.headers["anthropic-version"], "2023-06-01", "and a version header");
  eq(f.calls[0].body.system, "SYS", "system prompt sent as its own field");
}

{
  const f = fakeFetch({ choices: [{ message: { content: "from openai" } }] });
  const c = createModelClient({ provider: "openai" }, { env: { OPENAI_API_KEY: "sk" }, fetchImpl: f });
  eq(await ask(c), "from openai", "openai response is read");
  ok(f.calls[0].url.endsWith("/chat/completions"), "posting to chat/completions");
  eq(f.calls[0].init.headers["authorization"], "Bearer sk", "with a bearer token");
  eq(f.calls[0].body.messages[0].role, "system", "system prompt sent as a system message");
  eq(f.calls[0].body.messages[1].content, "USER", "and the user prompt after it");
}

{
  const f = fakeFetch({ candidates: [{ content: { parts: [{ text: "from " }, { text: "gemini" }] } }] });
  const c = createModelClient({ provider: "gemini" }, { env: { GEMINI_API_KEY: "SECRET-KEY-123" }, fetchImpl: f });
  eq(await ask(c), "from gemini", "gemini parts are joined");
  ok(f.calls[0].url.includes(":generateContent"), "posting to generateContent");
  eq(f.calls[0].init.headers["x-goog-api-key"], "SECRET-KEY-123", "key travels in a header");
  ok(!f.calls[0].url.includes("SECRET-KEY-123"), "and never in the url, where logs and errors would keep it");
  eq(f.calls[0].body.systemInstruction.parts[0].text, "SYS", "system prompt as systemInstruction");
}

{
  const f = fakeFetch({ message: { content: "from ollama" } });
  const c = createModelClient({ provider: "ollama" }, { env: {}, fetchImpl: f });
  eq(await ask(c), "from ollama", "ollama response is read");
  ok(c !== null, "ollama needs no api key at all");
  ok(f.calls[0].url.endsWith("/api/chat"), "posting to the ollama chat endpoint");
  eq(f.calls[0].body.stream, false, "streaming off, since we want one whole answer");
}

/* ---- any OpenAI-compatible endpoint ---- */
{
  const f = fakeFetch({ choices: [{ message: { content: "from a local server" } }] });
  const c = createModelClient(
    { provider: "openai", baseUrl: "http://127.0.0.1:1234/v1", model: "qwen2.5-coder" },
    { env: { OPENAI_API_KEY: "unused-locally" }, fetchImpl: f },
  );
  eq(await ask(c), "from a local server", "a local OpenAI-compatible server works");
  eq(f.calls[0].url, "http://127.0.0.1:1234/v1/chat/completions", "at the given base url");
  eq(f.calls[0].body.model, "qwen2.5-coder", "with the given model id");
  eq(c.name, "openai:qwen2.5-coder", "named for what it actually is");
}

{
  const f = fakeFetch({ content: [{ type: "text", text: "ok" }] });
  const c = createModelClient({ provider: "anthropic", baseUrl: "https://gw.example.com/anthropic/" },
    { env: { ANTHROPIC_API_KEY: "k" }, fetchImpl: f });
  await ask(c);
  eq(f.calls[0].url, "https://gw.example.com/anthropic/v1/messages", "a trailing slash on baseUrl is not doubled");
}

/* ---- provider detection ---- */
eq(detectProvider({ ANTHROPIC_API_KEY: "k" }), "anthropic", "anthropic detected from its key");
eq(detectProvider({ OPENAI_API_KEY: "k" }), "openai", "openai detected from its key");
eq(detectProvider({ GEMINI_API_KEY: "k" }), "gemini", "gemini detected from GEMINI_API_KEY");
eq(detectProvider({ GOOGLE_API_KEY: "k" }), "gemini", "or from GOOGLE_API_KEY");
eq(detectProvider({ OLLAMA_HOST: "http://x" }), "ollama", "ollama only when pointed at explicitly");
eq(detectProvider({}), null, "nothing configured means no provider");
eq(detectProvider({ MENDER_PROVIDER: "openai", ANTHROPIC_API_KEY: "k" }), "openai",
   "an explicit MENDER_PROVIDER wins over key order");
eq(detectProvider({ MENDER_PROVIDER: "nonsense" }), null, "an unknown provider name is not honoured");
ok(KEY_VARS.ollama.length === 0, "ollama has no key variables by design");

eq(createModelClient({}, { env: {} }), null, "no configuration yields no client, not an error");
eq(createModelClient({ provider: "openai" }, { env: {} }), null, "a hosted provider without its key yields null");
ok(createModelClient({ provider: "ollama" }, { env: {} }) !== null, "but a local one does not need a key");

{
  const d = describeModel({}, { OPENAI_API_KEY: "k" });
  eq(d.provider, "openai", "describeModel reports the provider");
  eq(d.model, "gpt-4o-mini", "and the default model");
  eq(d.hasKey, true, "and whether a key is present");
  eq(describeModel({}, {}).provider, null, "or that nothing is configured");
  eq(describeModel({ provider: "openai" }, {}).keyVar, "OPENAI_API_KEY", "naming the variable to set");
}

/* ---- custom key variable ---- */
{
  const f = fakeFetch({ choices: [{ message: { content: "ok" } }] });
  const c = createModelClient({ provider: "openai", apiKeyEnv: "WORK_OPENAI_KEY" },
    { env: { WORK_OPENAI_KEY: "custom" }, fetchImpl: f });
  await ask(c);
  eq(f.calls[0].init.headers["authorization"], "Bearer custom", "a custom key variable is honoured");
}

/* ---- robustness ---- */
eq(isRetryable(429), true, "rate limits are retryable");
eq(isRetryable(503), true, "so are server errors");
eq(isRetryable(500), true, "and 500s");
eq(isRetryable(400), false, "a bad request is not");
eq(isRetryable(401), false, "nor is an auth failure");

{
  // Fails twice, then succeeds. The caller should never see the failures.
  let n = 0;
  const impl = async () => {
    n++;
    if (n < 3) {
      return { ok: false, status: 503, headers: { get: () => null }, async text() { return "overloaded"; } };
    }
    return { ok: true, status: 200, headers: { get: () => null }, async json() { return { choices: [{ message: { content: "eventually" } }] }; } };
  };
  const slept = [];
  const c = createModelClient({ provider: "openai" },
    { env: { OPENAI_API_KEY: "k" }, fetchImpl: impl, sleep: async (ms) => slept.push(ms) });
  eq(await ask(c), "eventually", "a transient failure is retried through to success");
  eq(n, 3, "three attempts made");
  ok(slept.length === 2 && slept[1] > slept[0], `backoff grows: ${slept.join(",")}`);
}

{
  // A 400 is the model telling us we are wrong; retrying cannot help.
  let n = 0;
  const impl = async () => {
    n++;
    return { ok: false, status: 400, headers: { get: () => null }, async text() { return "bad model id"; } };
  };
  const c = createModelClient({ provider: "openai" },
    { env: { OPENAI_API_KEY: "k" }, fetchImpl: impl, sleep: async () => {} });
  let err = null;
  try { await ask(c); } catch (e) { err = e; }
  ok(err instanceof ProviderError, "a non-retryable failure throws ProviderError");
  eq(n, 1, "and is not retried");
  ok(err.message.includes("bad model id"), "the provider's own message is preserved");
}

{
  const impl = async () => { throw new Error("ECONNREFUSED"); };
  const c = createModelClient({ provider: "ollama" },
    { env: {}, fetchImpl: impl, sleep: async () => {}, });
  let err = null;
  try { await ask(c); } catch (e) { err = e; }
  ok(err instanceof ProviderError, "a transport failure surfaces as ProviderError");
  ok(err.message.includes("ECONNREFUSED"), "with the underlying reason");
}

{
  // Retry-After is respected rather than guessed at.
  const impl = async (_u, _i) => ({
    ok: false, status: 429,
    headers: { get: (k) => (k.toLowerCase() === "retry-after" ? "2" : null) },
    async text() { return "slow down"; },
  });
  const slept = [];
  const c = createModelClient({ provider: "openai", retries: 1 },
    { env: { OPENAI_API_KEY: "k" }, fetchImpl: impl, sleep: async (ms) => slept.push(ms) });
  try { await ask(c); } catch { /* expected */ }
  eq(slept[0], 2000, "Retry-After seconds are honoured");
}

/* ---- the repair loop treats every provider identically ---- */
{
  const { proposeWithModel } = await import("../dist/llm.js");
  const { parse } = await import("../dist/html.js");
  const { loadSpec } = await import("../dist/config.js");
  const { readFileSync } = await import("node:fs");

  const spec = loadSpec("examples/scrapers/pricing.json");
  const input = {
    spec,
    target: "price",
    liveDoc: parse(readFileSync("examples/pages/v2-price-moved.html", "utf8")),
    goldenDocs: [{ source: "g", doc: parse(readFileSync("examples/pages/v1-original.html", "utf8")) }],
    liveRowSelector: ".pricing-card",
  };

  const reply = JSON.stringify({ selectors: [".price-value"], note: "moved" });
  for (const [provider, payload, env] of [
    ["anthropic", { content: [{ type: "text", text: reply }] }, { ANTHROPIC_API_KEY: "k" }],
    ["openai", { choices: [{ message: { content: reply } }] }, { OPENAI_API_KEY: "k" }],
    ["gemini", { candidates: [{ content: { parts: [{ text: reply }] } }] }, { GEMINI_API_KEY: "k" }],
    ["ollama", { message: { content: reply } }, {}],
  ]) {
    const c = createModelClient({ provider }, { env, fetchImpl: fakeFetch(payload) });
    const candidates = await proposeWithModel(c, input);
    eq(candidates.length, 1, `${provider} proposals reach the repair loop`);
    eq(candidates[0].selector, ".price-value", `${provider} selector parsed identically`);
  }
}
