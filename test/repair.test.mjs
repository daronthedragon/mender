import { eq, ok, section } from "./harness.mjs";
import { readFileSync } from "node:fs";
import { loadSpec } from "../dist/config.js";
import { runCheck, runRepair } from "../dist/repair.js";
import { unionSelector, kindOf } from "../dist/verify.js";

section("repair, end to end");

const spec = loadSpec("examples/scrapers/pricing.json");
const page = (f) => readFileSync(`examples/pages/${f}`, "utf8");
const repair = (f) => runRepair(spec, { fixturesRoot: "examples/fixtures", html: page(f) });

eq(unionSelector(".amount", "[data-testid=x]"), ".amount, [data-testid=x]", "union keeps the old branch");
eq(unionSelector(undefined, ".new"), ".new", "no previous selector means no union");
eq(unionSelector(".a, .b", ".b"), ".a, .b", "an already-present branch is not duplicated");

eq(kindOf("$19"), "currency", "a dollar amount is currency");
eq(kindOf("19.99 EUR"), "currency", "a currency code counts as currency");
eq(kindOf("4.8"), "numeric", "a bare number is numeric");
eq(kindOf("Talk to sales"), "words-mid", "a phrase is words");
eq(kindOf(""), "empty", "empty text has its own kind");

/* ---- the healthy case ---- */
{
  const check = await runCheck(spec, { html: page("v1-original.html") });
  eq(check.cause, "OK", "the original page passes its contract");
  eq(check.rows.length, 3, "three plans extracted");
  eq(check.rows[2].price, 199, "the last price parses");
  eq(check.rows[1].features.length, 4, "the Pro plan lists four features");

  const outcome = await repair("v1-original.html");
  eq(outcome.attempted, false, "a passing scraper is not repaired");
  eq(outcome.skippedReason, "contract already passes", "and says why");
}

/* ---- a field moved to new markup ---- */
{
  const outcome = await repair("v2-price-moved.html");
  eq(outcome.check.cause, "LAYOUT_CHANGE", "diagnosed as a layout change");
  eq(outcome.fixes.length, 1, "one selector repaired");
  eq(outcome.fixes[0].target, "price", "the broken field is the one repaired");
  eq(outcome.fixes[0].proposed, '[data-testid="price-value"]', "it prefers the stable test id over a class");
  eq(outcome.fixes[0].selector, '.amount, [data-testid="price-value"]', "and unions it with the old selector");
  eq(outcome.fixes[0].verified, true, "the accepted fix cleared every gate");
  ok(
    outcome.fixes[0].passes.every((p) => p.ok),
    "every gate reported ok",
  );
  eq(outcome.unresolved.length, 0, "nothing left broken");
}

/* ---- the row container was renamed ---- */
{
  const outcome = await repair("v3-rows-renamed.html");
  eq(outcome.fixes.length, 1, "one repair for the row selector");
  eq(outcome.fixes[0].target, "__row__", "the row selector is what broke");
  eq(outcome.fixes[0].selector, ".pricing-card, .plan-card", "unioned row selector");
  eq(outcome.check.rows.length, 0, "before the repair, zero rows were found");
}

/* ---- the trap: a plausible wrong element is available ---- */
{
  const outcome = await repair("v4-price-gone-trap.html");
  eq(outcome.fixes.length, 0, "no repair is accepted when the field is genuinely gone");
  eq(outcome.unresolved.join(), "price", "price is reported as still broken");
  ok(outcome.rejectedCount >= 3, "several candidates were considered and rejected");
  ok(
    outcome.rejections.some((r) => r.selector === ".rating-value" && r.failedGate === "continuity"),
    "the rating element was rejected specifically by the continuity gate",
  );
}

/* ---- blocked: the case that must never rewrite a selector ---- */
{
  const outcome = await repair("blocked.html");
  eq(outcome.check.cause, "BLOCKED", "diagnosed as blocked");
  eq(outcome.attempted, false, "no repair attempted");
  eq(outcome.fixes.length, 0, "no selector was changed");
  ok(outcome.skippedReason.includes("selectors left untouched"), "and says so plainly");
}

/* ---- no reference to learn from ---- */
{
  const outcome = await runRepair(spec, {
    fixturesRoot: "examples/does-not-exist",
    html: page("v2-price-moved.html"),
  });
  eq(outcome.attempted, false, "without fixtures there is nothing to learn from");
  ok(outcome.skippedReason.includes("no fixtures"), "and the message says to archive one");
}

/* ---- a stale fixture is excluded rather than trusted ---- */
{
  const outcome = await runRepair(spec, {
    fixturesRoot: "examples/fixtures-stale",
    html: page("v2-price-moved.html"),
  });
  eq(outcome.staleFixtures.length, 1, "the stale fixture is identified");
  eq(outcome.attempted, false, "and repair stops rather than learning from it");
}
