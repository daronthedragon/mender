/**
 * Benchmark for the mender hot path. Runs against the built dist/.
 *
 *   ./node_modules/.bin/tsc && node bench/bench.mjs
 *
 * Reports the median of N timed iterations (after warmup) so a single GC pause
 * cannot fake a regression or an improvement.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generatePage, BENCH_SPEC } from "./gen.mjs";

const { parse, descendants, walk, normText } = await import("../dist/html.js");
const { querySelectorAll, matches } = await import("../dist/select.js");
const { extract } = await import("../dist/extract.js");
const { runCheck, runRepair } = await import("../dist/repair.js");
const { propose } = await import("../dist/propose.js");

/* ---------- timing ---------- */

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const results = [];

async function bench(name, fn, { iters = 30, warmup = 5 } = {}) {
  for (let i = 0; i < warmup; i++) await fn();
  const times = [];
  for (let i = 0; i < iters; i++) {
    const t0 = performance.now();
    await fn();
    times.push(performance.now() - t0);
  }
  const med = median(times);
  results.push({ name, med, min: Math.min(...times), max: Math.max(...times), iters });
  console.log(
    `${name.padEnd(46)} median ${med.toFixed(3).padStart(9)} ms   ` +
      `min ${Math.min(...times).toFixed(3).padStart(9)}   ` +
      `max ${Math.max(...times).toFixed(3).padStart(9)}   (n=${iters})`,
  );
  return med;
}

/* ---------- inputs ---------- */

const bigHtml = generatePage({ rows: 200, fields: 12, seed: 7 });
const bigDoc = parse(bigHtml);
let bigCount = 0;
walk(bigDoc, () => bigCount++);

// The same page with the price element renamed: the field selector breaks and
// repair has to score every descendant of every row.
const brokenHtml = generatePage({ rows: 200, fields: 12, seed: 7, priceClass: "price-value" });

const realPages = {};
for (const f of [
  "v1-original.html",
  "v2-price-moved.html",
  "v3-rows-renamed.html",
  "v4-price-gone-trap.html",
  "v5-price-in-prose.html",
  "v6-prices-with-tax.html",
]) {
  realPages[f] = readFileSync(join("examples", "pages", f), "utf8");
}
const realSpec = JSON.parse(readFileSync(join("examples", "scrapers", "pricing.json"), "utf8"));
const realDocs = Object.fromEntries(Object.entries(realPages).map(([k, v]) => [k, parse(v)]));

// A fixtures root for the synthetic repair, written to a temp dir.
const fixRoot = join(tmpdir(), "mender-bench-fixtures");
rmSync(fixRoot, { recursive: true, force: true });
mkdirSync(join(fixRoot, "bench"), { recursive: true });
for (let i = 0; i < 3; i++) {
  writeFileSync(
    join(fixRoot, "bench", `2026-0${i + 1}-01.html`),
    generatePage({ rows: 200, fields: 12, seed: 7 + i }),
  );
}

console.log(
  `page: ${(bigHtml.length / 1024).toFixed(1)} KiB, ${bigCount} elements, ` +
    `${descendants(bigDoc).length} descendants of #document\n`,
);

/* ---------- (a) parse throughput ---------- */

await bench("a1  parse 200x12 synthetic page", () => { parse(bigHtml); }, { iters: 40 });
await bench(
  "a2  parse all 6 example fixtures x20",
  () => { for (let i = 0; i < 20; i++) for (const h of Object.values(realPages)) parse(h); },
  { iters: 30 },
);

/* ---------- (b) querySelectorAll over a large document ---------- */

await bench("b1  qsa .product-card (200 hits)", () => { querySelectorAll(bigDoc, ".product-card"); }, { iters: 60 });
await bench("b2  qsa .amount (200 hits)", () => { querySelectorAll(bigDoc, ".amount"); }, { iters: 60 });
await bench("b3  qsa span (deep tag scan)", () => { querySelectorAll(bigDoc, "span"); }, { iters: 60 });
await bench("b4  qsa [data-testid=rating]", () => { querySelectorAll(bigDoc, "[data-testid=rating]"); }, { iters: 60 });
await bench(
  "b5  qsa .product-card .meta > .meta-value",
  () => { querySelectorAll(bigDoc, ".product-card .meta > .meta-value"); },
  { iters: 40 },
);
await bench("b6  qsa li.feature:nth-child(2)", () => { querySelectorAll(bigDoc, "li.feature:nth-child(2)"); }, { iters: 40 });
await bench("b7  qsa .missing-class (0 hits)", () => { querySelectorAll(bigDoc, ".missing-class"); }, { iters: 60 });

// Per-row field extraction: the pattern extract.ts uses, 200 rows x 12 fields.
const rowEls = querySelectorAll(bigDoc, ".product-card");
await bench(
  "b8  qsa 12 field selectors inside 200 rows",
  () => {
    for (const row of rowEls) {
      for (const f of Object.values(BENCH_SPEC.fields)) querySelectorAll(row, f.selector);
    }
  },
  { iters: 20 },
);

await bench(
  "b9  matches() every descendant vs 4 selectors",
  () => {
    const all = descendants(bigDoc);
    for (const el of all) {
      matches(el, ".product-card");
      matches(el, "span.meta-value");
      matches(el, ".product-card .amount");
      matches(el, "li:nth-child(2)");
    }
  },
  { iters: 10 },
);

/* ---------- (c) full runCheck ---------- */

await bench("c1  runCheck big synthetic page", () => runCheck(BENCH_SPEC, { html: bigHtml }), { iters: 20 });
await bench(
  "c2  runCheck real pricing page x20",
  async () => { for (let i = 0; i < 20; i++) await runCheck(realSpec, { html: realPages["v1-original.html"] }); },
  { iters: 20 },
);

/* ---------- (d) full runRepair ---------- */

await bench(
  "d1  runRepair real v2-price-moved x10",
  async () => {
    for (let i = 0; i < 10; i++) {
      await runRepair(realSpec, { fixturesRoot: "examples/fixtures", html: realPages["v2-price-moved.html"] });
    }
  },
  { iters: 15 },
);
await bench(
  "d2  runRepair real v3-rows-renamed x10",
  async () => {
    for (let i = 0; i < 10; i++) {
      await runRepair(realSpec, { fixturesRoot: "examples/fixtures", html: realPages["v3-rows-renamed.html"] });
    }
  },
  { iters: 15 },
);
await bench(
  "d3  runRepair 200-row synthetic (price renamed)",
  () => runRepair(BENCH_SPEC, { fixturesRoot: fixRoot, html: brokenHtml }),
  { iters: 7, warmup: 2 },
);

// The scoring inner loop on its own, without fetch/validate overhead.
{
  const goldenDocs = [{ source: "g", doc: bigDoc }];
  const liveDoc = parse(brokenHtml);
  await bench(
    "d4  propose(price) over 200 rows",
    () => { propose({ spec: BENCH_SPEC, liveDoc, goldenDocs, target: "price" }); },
    { iters: 7, warmup: 2 },
  );
  await bench(
    "d5  propose(__row__) over 200 rows",
    () => { propose({ spec: BENCH_SPEC, liveDoc, goldenDocs, target: "__row__" }); },
    { iters: 7, warmup: 2 },
  );
}

/* ---------- machine-readable tail ---------- */

console.log("\n--- JSON ---");
console.log(JSON.stringify(results.map((r) => [r.name, +r.med.toFixed(4)])));

rmSync(fixRoot, { recursive: true, force: true });
