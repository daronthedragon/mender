import { eq, ok, section } from "./harness.mjs";
import { readFileSync } from "node:fs";
import { loadSpec } from "../dist/config.js";
import { runRepair, runCheck } from "../dist/repair.js";
import { verifyCandidate } from "../dist/verify.js";
import { parse } from "../dist/html.js";

section("coverage gate: records carved up wrongly");

const spec = loadSpec("examples/scrapers/pricing.json");
const page = (f) => readFileSync(`examples/pages/${f}`, "utf8");
const goldens = [{ source: "2026-07-02", doc: parse(readFileSync("examples/fixtures/pricing/2026-07-02.html", "utf8")) }];

const tryRow = (html, selector) =>
  verifyCandidate({
    spec,
    candidate: { target: "__row__", selector, score: 1, reason: "test", via: "test" },
    live: { source: "live", doc: parse(html) },
    goldens,
  });

const gate = (result, name) => result.passes.find((p) => p.source === name);

/* ---- the failure the first three gates cannot see ---- */
{
  // ".pair" wraps two records each: the contract passes, the values are the
  // right kind, and the archive is untouched because ".pair" is not in it.
  const r = tryRow(page("v7-rows-regrouped.html"), ".pair");

  eq(gate(r, "live").ok, true, "a two-records-per-match selector still satisfies the contract");
  eq(gate(r, "2026-07-02").ok, true, "and leaves the archive byte-identical");
  eq(gate(r, "continuity").ok, true, "and the values it does capture are the right kind");

  eq(gate(r, "coverage").ok, false, "only the coverage gate objects");
  ok(gate(r, "coverage").detail.includes("2 of 4"), `and counts what is lost: ${gate(r, "coverage").detail}`);
  ok(gate(r, "coverage").detail.includes("silently dropped"), "naming the consequence");
  eq(r.verified, false, "so the candidate is refused");
}

/* ---- and the right answer is still reachable ---- */
{
  const outcome = await runRepair(spec, {
    fixturesRoot: "examples/fixtures",
    html: page("v7-rows-regrouped.html"),
  });
  eq(outcome.fixes.length, 1, "a repair is still found");
  eq(outcome.fixes[0].selector, ".pricing-card, .pair > article", "the one that reaches every record");

  const after = await runCheck(outcome.patched, { html: page("v7-rows-regrouped.html") });
  eq(after.rows.length, 4, "all four records extracted, not two");
  eq(
    after.rows.map((r) => `${r.plan}:${r.price}`).join(","),
    "Starter:19,Pro:49,Scale:199,Enterprise:499",
    "with each price attached to its own plan",
  );
}

/* ---- it must not reject legitimate repairs ---- */
{
  const moved = await runRepair(spec, { fixturesRoot: "examples/fixtures", html: page("v2-price-moved.html") });
  eq(moved.fixes.length, 1, "a moved field still repairs");
  eq(gate(moved.fixes[0], "coverage").ok, true, "coverage is satisfied by a genuine field repair");

  const renamed = await runRepair(spec, { fixturesRoot: "examples/fixtures", html: page("v3-rows-renamed.html") });
  eq(renamed.fixes.length, 1, "a renamed row container still repairs");
  eq(gate(renamed.fixes[0], "coverage").ok, true, "coverage is satisfied by a genuine row repair");

  const prose = await runRepair(spec, { fixturesRoot: "examples/fixtures", html: page("v5-price-in-prose.html") });
  eq(prose.fixes.length, 0, "the prose page still needs a model, as before");
}

/* ---- a healthy page is unaffected ---- */
{
  const r = tryRow(page("v1-original.html"), ".pricing-card");
  eq(gate(r, "coverage").ok, true, "an unchanged page passes coverage");
}

/* ---- selectors that reach MORE than before are not penalised ---- */
{
  // Rows that capture everything the archive did, and the archive captured all
  // of it, is the normal case; over-capturing is not this gate's business.
  const r = tryRow(page("v3-rows-renamed.html"), ".plan-card");
  eq(gate(r, "coverage").ok, true, "capturing the same fraction is fine");
}

section("a row selector must select records");

/**
 * Found by mutating real pages. Judging a row repair on row COUNT alone let a
 * candidate add a table header row to 1,595 real ones on the IANA TLD list: the
 * count stayed inside expectations, the archive was untouched because the new
 * branch matched nothing there, and coverage was unaffected — so every gate
 * passed while the data gained `{"domain": null, "type": "Domain"}`.
 */
{
  const { inferSpec } = await import("../dist/init.js");
  const html = readFileSync("examples/pages/v10-tables.html", "utf8");
  const tableSpec = inferSpec(html, "https://example.com/stock", "stock").spec;

  const before = (await runCheck(tableSpec, { html })).rows;
  eq(before.length, 5, "five records before anything breaks");

  // The header row is a <tr> like any other; a selector reaching it adds a row
  // whose cells are all <th>, so every td-addressed field comes back null.
  const withHeader = { ...tableSpec, row: "table.stock tr" };
  const bad = await runCheck(withHeader, { html });
  eq(bad.rows.length, 6, "a selector that reaches the header yields one row too many");
  eq(bad.rows[0].supplier, null, "and that row is empty where a record would have values");

  const verdict = verifyCandidate({
    spec: tableSpec,
    candidate: { target: "__row__", selector: "table.stock tr", score: 1, reason: "t", via: "t" },
    live: { source: "live", doc: parse(html) },
    goldens: [{ source: "g", doc: parse(html) }],
  });
  const liveGate = verdict.passes.find((p) => p.source === "live");
  eq(liveGate.ok, false, "the live gate refuses it");
  ok(
    liveGate.detail.includes("not records"),
    `naming why rather than citing a row count: ${liveGate.detail}`,
  );
  eq(verdict.verified, false, "so the candidate is not accepted");
}

{
  // A field broken in EVERY row is independently broken and must not block a
  // row repair — the row is fixed first and the field is repaired after.
  const { inferSpec } = await import("../dist/init.js");
  const html = readFileSync("examples/pages/v10-tables.html", "utf8");
  const base = inferSpec(html, "https://example.com/stock", "stock").spec;
  const withDeadField = {
    ...base,
    fields: { ...base.fields, supplier: { ...base.fields.supplier, selector: ".gone" } },
  };
  const verdict = verifyCandidate({
    spec: withDeadField,
    candidate: { target: "__row__", selector: base.row, score: 1, reason: "t", via: "t" },
    live: { source: "live", doc: parse(html) },
    goldens: [],
  });
  const liveGate = verdict.passes.find((p) => p.source === "live");
  eq(liveGate.ok, true, "a wholly broken field does not veto the row repair");
}

