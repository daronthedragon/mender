import { eq, ok, section } from "./harness.mjs";
import { readFileSync } from "node:fs";
import { loadSpec } from "../dist/config.js";
import { runRepair } from "../dist/repair.js";
import { parseModelReply, proposeWithModel, anthropicClient } from "../dist/llm.js";
import { parse } from "../dist/html.js";

section("llm proposer");

const spec = loadSpec("examples/scrapers/pricing.json");
const page = (f) => readFileSync(`examples/pages/${f}`, "utf8");

function fakeClient(reply, name = "fake-model") {
  const calls = [];
  return {
    name,
    calls,
    async complete(req) {
      calls.push(req);
      if (typeof reply === "function") return reply(req);
      return reply;
    },
  };
}

const json = (selectors, note = "") => JSON.stringify({ selectors, note });

/* ---- reply parsing ---- */
eq(parseModelReply(json([".a", ".b"])).selectors.join(","), ".a,.b", "plain json");
eq(parseModelReply("```json\n" + json([".a"]) + "\n```").selectors.join(","), ".a", "fenced json");
eq(
  parseModelReply("Here you go:\n" + json([".a"]) + "\nHope that helps.").selectors.join(","),
  ".a",
  "json embedded in prose",
);
eq(parseModelReply("not json at all").selectors.length, 0, "no json means no selectors");
eq(parseModelReply("{broken").selectors.length, 0, "malformed json means no selectors");
eq(parseModelReply(json([])).selectors.length, 0, "an empty list is respected, not second-guessed");
eq(
  parseModelReply(JSON.stringify({ selectors: [".a", 42, "", null, ".b"] })).selectors.join(","),
  ".a,.b",
  "non-string entries are dropped",
);

/* ---- proposal hygiene ---- */
{
  const input = {
    spec,
    target: "price",
    liveDoc: parse(page("v2-price-moved.html")),
    goldenDocs: [{ source: "g", doc: parse(page("v1-original.html")) }],
    liveRowSelector: ".pricing-card",
  };

  const bad = await proposeWithModel(fakeClient(json(["div[unclosed", ".valid", "..broken", ".valid"])), input);
  eq(bad.map((c) => c.selector).join(","), ".valid", "unparseable selectors are dropped and duplicates collapsed");
  eq(bad[0].target, "price", "candidates carry their target");

  const many = await proposeWithModel(
    fakeClient(json([".a", ".b", ".c", ".d", ".e", ".f", ".g", ".h"])),
    input,
  );
  eq(many.length, 6, "the number of model candidates is capped");

  const exploded = await proposeWithModel(
    { name: "boom", async complete() { throw new Error("503 overloaded"); } },
    input,
  );
  eq(exploded.length, 0, "a model outage degrades to no proposal, never to a wrong one");

  // The prompt has to actually carry the evidence.
  const spy = fakeClient(json([]));
  await proposeWithModel(spy, input);
  ok(spy.calls[0].user.includes(".amount"), "the prompt names the selector that broke");
  ok(spy.calls[0].user.includes("pricing-card"), "the prompt includes the live markup");
  ok(spy.calls[0].user.includes("$19"), "the prompt shows the value that used to be extracted");
  ok(spy.calls[0].system.includes("empty list"), "the system prompt tells it that no answer is allowed");
}

/* ---- integration: the model earns nothing by being a model ---- */
const repairWith = (file, client) =>
  runRepair(spec, { fixturesRoot: "examples/fixtures", html: page(file), model: client });

{
  // Heuristics cannot see a price buried in prose. The model can.
  const client = fakeClient(json([".blurb"], "the price moved into the description"));
  const outcome = await repairWith("v5-price-in-prose.html", client);
  eq(client.calls.length, 1, "the model was consulted once");
  eq(outcome.fixes.length, 1, "the model's proposal was accepted");
  eq(outcome.fixes[0].via, "fake-model", "the fix records which proposer produced it");
  eq(outcome.fixes[0].selector, ".amount, .blurb", "and is unioned like any other repair");
  eq(outcome.modelUsed, "fake-model", "the outcome reports the model that was used");
  eq(outcome.check.rows[0].price, null, "before the repair the price was missing");
}

{
  // The identical mechanism must NOT rescue a wrong answer. This selector picks
  // the same wrong element as the heuristics did, written a way they did not try.
  const client = fakeClient(json(['[class="rating-value"]'], "this looks like the price"));
  const outcome = await repairWith("v4-price-gone-trap.html", client);
  eq(client.calls.length, 1, "the model was consulted on the trap page too");
  eq(outcome.fixes.length, 0, "but its proposal was not accepted");
  ok(
    outcome.rejections.some((r) => r.via === "fake-model" && r.failedGate === "continuity"),
    "the model's proposal was rejected by the same continuity gate as the heuristics",
  );
}

{
  // Cost control again: re-proposing something already verified is skipped.
  const client = fakeClient(json([".rating-value"], "same as a heuristic guess"));
  const outcome = await repairWith("v4-price-gone-trap.html", client);
  eq(outcome.fixes.length, 0, "still no repair");
  ok(
    !outcome.rejections.some((r) => r.via === "fake-model"),
    "a model proposal the heuristics already tried is not verified twice",
  );
}

{
  // Cost control: a solved problem must not reach the model.
  const client = fakeClient(json([".anything"]));
  const outcome = await repairWith("v2-price-moved.html", client);
  eq(client.calls.length, 0, "heuristics solved it, so the model was never called");
  eq(outcome.fixes[0].via, "heuristic", "and the fix is attributed to the heuristics");
  eq(outcome.modelUsed, null, "no model was used");
}

{
  // Safety: a blocked page must not even spend a token.
  const client = fakeClient(json([".anything"]));
  const outcome = await repairWith("blocked.html", client);
  eq(client.calls.length, 0, "a blocked page never reaches the model");
  eq(outcome.fixes.length, 0, "and nothing is changed");
}

{
  const client = fakeClient("I think the selector should be .price maybe?");
  const outcome = await repairWith("v5-price-in-prose.html", client);
  eq(outcome.fixes.length, 0, "prose with no json yields no repair");
  eq(outcome.unresolved.join(), "price", "and the field stays reported as broken");
}

{
  // An empty list is the model saying "the value is gone". It must be honoured.
  const client = fakeClient(json([], "the price is no longer on this page"));
  const outcome = await repairWith("v4-price-gone-trap.html", client);
  eq(outcome.fixes.length, 0, "an empty list produces no repair");
}

/* ---- client construction ---- */
{
  const saved = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  eq(anthropicClient(), null, "no api key means no client, rather than a crash at call time");
  eq(anthropicClient({ apiKey: "sk-test", model: "claude-sonnet-5" }).name, "claude-sonnet-5", "an explicit key builds a client");
  if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
}
