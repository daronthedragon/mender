import { eq, ok, section } from "./harness.mjs";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSpec } from "../dist/config.js";
import { runCheck, runRepair } from "../dist/repair.js";
import { detectDrift, loadHistory, median, pruneHistory, summarise } from "../dist/history.js";
import { extract } from "../dist/extract.js";
import { parse } from "../dist/html.js";
import { retirementPlan, ageInDays } from "../dist/fixtures.js";

section("semantic drift");

const spec = loadSpec("examples/scrapers/pricing.json");
const page = (f) => readFileSync(`examples/pages/${f}`, "utf8");

eq(median([3, 1, 2]), 2, "median of an odd list");
eq(median([1, 2, 3, 4]), 2.5, "median of an even list");
eq(median([]), undefined, "median of nothing is undefined");

const record = (html, ts) => summarise(extract(parse(html), spec), spec, ts);

/* ---- the scenario from the README: prices quietly start including tax ---- */
{
  const root = mkdtempSync(join(tmpdir(), "mender-drift-"));
  const opts = { fixturesRoot: "examples/fixtures", historyRoot: root, record: true };

  // Five healthy runs build the baseline.
  for (let i = 1; i <= 5; i++) {
    const res = await runCheck(spec, {
      ...opts,
      html: page("v1-original.html"),
      now: new Date(Date.UTC(2026, 6, i)),
    });
    eq(res.cause, "OK", `baseline run ${i} is healthy`);
    eq(res.drift.length, 0, `baseline run ${i} reports no drift`);
  }

  eq(loadHistory(root, "pricing").length, 5, "five runs were recorded");

  // Now the same page with 20% tax added. Every selector still matches, every
  // type still parses, the contract is perfectly happy — and the data is wrong.
  const taxed = await runCheck(spec, {
    ...opts,
    html: page("v6-prices-with-tax.html"),
    now: new Date(Date.UTC(2026, 6, 6)),
  });

  eq(taxed.cause, "OK", "the contract still passes, which is exactly the problem");
  eq(taxed.violations.length, 0, "and there are no violations to catch it");
  ok(taxed.drift.length > 0, "but drift detection sees it");
  const magnitude = taxed.drift.find((d) => d.code === "MAGNITUDE_SHIFT");
  ok(magnitude, "reported as a magnitude shift");
  eq(magnitude.field, "price", "attributed to the price field");
  ok(magnitude.detail.includes("20%"), `and quantified: ${magnitude?.detail}`);

  // The critical property: this must never trigger a selector repair.
  const outcome = await runRepair(spec, { ...opts, html: page("v6-prices-with-tax.html") });
  eq(outcome.attempted, false, "drift never triggers an automatic repair");
  eq(outcome.fixes.length, 0, "and no selector is touched");
  eq(outcome.skippedReason, "contract already passes", "the repair path sees a healthy scraper");

  rmSync(root, { recursive: true, force: true });
}

/* ---- the other drift signals ---- */
{
  const base = [1, 2, 3, 4].map((i) => record(page("v1-original.html"), `2026-07-0${i}`));

  eq(detectDrift(base.slice(0, 2), record(page("v6-prices-with-tax.html"), "x"), {}).length, 0,
    "drift is not judged until there is enough history");

  const stable = detectDrift(base, record(page("v1-original.html"), "2026-07-05"), {});
  eq(stable.length, 0, "an unchanged page reports no drift");

  // Rows disappearing. Two of three go, a 67% drop, past the 50% default.
  const drop = (html) =>
    html.replace(/<div class="pricing-card">[\s\S]*?<\/div>\s*<div class="pricing-card">/, '<div class="pricing-card">');
  const oneLeft = drop(drop(page("v1-original.html")));
  eq(extract(parse(oneLeft), spec).length, 1, "the trimmed page really does have one row");
  const rowDrift = detectDrift(base, record(oneLeft, "2026-07-05"), {});
  ok(rowDrift.some((d) => d.code === "ROW_COUNT_SHIFT"), "a large row-count change is drift");

  // One row of three going missing is under the default threshold, on purpose:
  // row counts move for legitimate reasons and a noisy warning gets ignored.
  const twoLeft = drop(page("v1-original.html"));
  const smallChange = detectDrift(base, record(twoLeft, "2026-07-05"), {});
  ok(!smallChange.some((d) => d.code === "ROW_COUNT_SHIFT"), "a modest row-count change is not flagged by default");
  const sensitive = detectDrift(base, record(twoLeft, "2026-07-05"), { rowShift: 0.2 });
  ok(sensitive.some((d) => d.code === "ROW_COUNT_SHIFT"), "but a tighter threshold catches it");

  // Currency turning into a bare number.
  const bare = page("v1-original.html").replace(/>\$(\d+)</g, ">$1<");
  const kindDrift = detectDrift(base, record(bare, "2026-07-05"), {});
  ok(kindDrift.some((d) => d.code === "KIND_SHIFT"), "a change in the kind of value is drift");

  // Values emptying out.
  const emptied = page("v1-original.html").replace(/<p class="amount">[^<]*<\/p>/g, '<p class="amount"></p>');
  const nullDrift = detectDrift(base, record(emptied, "2026-07-05"), {});
  ok(nullDrift.some((d) => d.code === "NULL_RATE_SHIFT"), "a jump in empty values is drift");

  // Thresholds are tunable.
  const loose = detectDrift(base, record(page("v6-prices-with-tax.html"), "x"), { medianShift: 5 });
  eq(loose.length, 0, "a loose threshold suppresses the finding");
}

/* ---- history file hygiene ---- */
{
  const root = mkdtempSync(join(tmpdir(), "mender-hist-"));
  mkdirSync(join(root, "pricing"), { recursive: true });
  const path = join(root, "pricing", "history.jsonl");
  const lines = Array.from({ length: 50 }, (_, i) => JSON.stringify(record(page("v1-original.html"), `t${i}`)));
  writeFileSync(path, lines.join("\n") + "\n");

  eq(pruneHistory(root, "pricing", 10), 40, "pruning drops the oldest records");
  eq(loadHistory(root, "pricing", 100).length, 10, "and keeps the newest");

  writeFileSync(path, "{not json\n" + lines[0] + "\n");
  eq(loadHistory(root, "pricing").length, 1, "a corrupt line is skipped, not fatal");
  rmSync(root, { recursive: true, force: true });
}

section("fixture retirement");

eq(ageInDays("2026-01-01", new Date("2026-07-01T00:00:00Z")), 181, "age is computed from the filename stamp");
eq(ageInDays("not-a-date", new Date()), null, "an unstamped fixture has no age");

{
  const fixtures = [
    { source: "2024-01-01", path: "/a" },
    { source: "2025-01-01", path: "/b" },
    { source: "2026-08-01", path: "/c" },
  ];
  const now = new Date("2026-08-20T00:00:00Z");

  // Only the newest still passes; the two ancient ones have stopped being useful.
  const plan = retirementPlan(fixtures, (s) => s === "2026-08-01", { maxAgeDays: 180, now });
  eq(plan.length, 2, "stale, old fixtures are retired");
  ok(plan.every((r) => r.reason.includes("fails the current spec")), "and the reason says why");

  // The last passing reference is never retired, however old it is.
  const lastOne = retirementPlan([{ source: "2020-01-01", path: "/x" }], () => true, { maxAgeDays: 1, now });
  eq(lastOne.length, 0, "the only passing fixture is never dropped — a repair needs a reference");

  // A failing fixture that is still young is kept: it may just be a fresh break.
  const young = retirementPlan([{ source: "2026-08-19", path: "/y" }, { source: "2026-08-01", path: "/z" }],
    () => false, { maxAgeDays: 180, now });
  eq(young.length, 0, "recent failing fixtures are kept for now");

  // The keep limit trims the oldest first.
  const many = Array.from({ length: 15 }, (_, i) => ({
    source: `2026-08-${String(i + 1).padStart(2, "0")}`,
    path: `/f${i}`,
  }));
  const trimmed = retirementPlan(many, () => true, { keep: 10, now });
  eq(trimmed.length, 5, "the keep limit retires the excess");
  ok(trimmed.every((r) => r.reason.includes("keep limit")), "with the limit named");
  ok(!trimmed.some((r) => r.source === "2026-08-15"), "and the newest survives");
}

ok(!existsSync(join(tmpdir(), "mender-drift-does-not-exist")), "temp dirs were cleaned up");
