/**
 * Isolates one line-level finding in src/propose.ts, which this benchmark's
 * author was not allowed to change.
 *
 * `scoreElement(el, row, exemplars)` recomputes three `modal(exemplars, ...)`
 * reductions on every call, but all three depend only on `exemplars`, which is
 * constant for the whole scoring pass. Repair calls scoreElement once per
 * descendant per row, so those reductions run (elements x exemplars) times
 * instead of once.
 *
 * This runs the real scoring arithmetic both ways over the real page and
 * reports the difference. It is a faithful copy of scoreElement, not the
 * shipped function — treat the number as the size of the prize, then make the
 * change in src/propose.ts and re-run bench/bench.mjs to confirm it.
 *
 *   node bench/propose-hoist.mjs
 */
import { generatePage, BENCH_SPEC } from "./gen.mjs";

const { parse, descendants, normText } = await import("../dist/html.js");
const { querySelectorAll } = await import("../dist/select.js");
const {
  STABLE_ATTRS, exemplarOf, jaccard, pathFrom, pathSimilarity, shapeOf, stableClasses,
} = await import("../dist/signature.js");

/* Copied verbatim from src/propose.ts, which does not export it. */
function modal(values, key) {
  const counts = new Map();
  for (const v of values) {
    const k = key(v);
    const hit = counts.get(k);
    if (hit) hit.n++;
    else counts.set(k, { n: 1, v });
  }
  let best = null;
  for (const entry of counts.values()) if (!best || entry.n > best.n) best = entry;
  return best?.v ?? null;
}

const MODALS = {
  tag: (ex) => modal(ex, (e) => e.tag)?.tag ?? "",
  classes: (ex) => modal(ex, (e) => e.classes.sort().join("."))?.classes ?? [],
  path: (ex) => modal(ex, (e) => e.path.map((p) => p.tag).join("/"))?.path ?? [],
};

/** The shipped shape: the three reductions run inside the per-element call. */
function scoreElementInline(el, row, exemplars) {
  return score(el, row, exemplars, {
    tag: MODALS.tag(exemplars),
    classes: MODALS.classes(exemplars),
    path: MODALS.path(exemplars),
  });
}

/** The proposed shape: the caller computes them once and passes them down. */
function scoreElementHoisted(el, row, exemplars, m) {
  return score(el, row, exemplars, m);
}

function score(el, row, exemplars, m) {
  if (exemplars.length === 0) return 0;
  const text = normText(el);
  if (!text && !STABLE_ATTRS.some((a) => el.attrs[a])) return 0;
  const shape = shapeOf(text);
  const classes = stableClasses(el);
  const path = pathFrom(row, el);

  let s = 0;
  if (exemplars.some((e) => e.text && e.text === text)) s += 4;
  else if (exemplars.some((e) => e.shape === shape && shape !== "")) s += 2.5;
  if (el.tag === m.tag) s += 1;
  s += 2.5 * jaccard(classes, m.classes);
  s += 2.5 * pathSimilarity(path, m.path);
  for (const a of STABLE_ATTRS) {
    const v = el.attrs[a];
    if (!v) continue;
    if (exemplars.some((e) => e.attrs[a] === v)) s += 3.5;
    else if (exemplars.some((e) => e.attrs[a] !== undefined)) s += 1;
    break;
  }
  const exemplarLen = exemplars[0].text.length || 1;
  if (text.length > exemplarLen * 3) s -= Math.min(2.5, text.length / (exemplarLen * 3));
  if (descendants(el).length > 6) s -= 1;
  return s;
}

const goldenDoc = parse(generatePage({ rows: 200, fields: 12, seed: 7 }));
const liveDoc = parse(generatePage({ rows: 200, fields: 12, seed: 7, priceClass: "price-value" }));

const exemplars = [];
for (const row of querySelectorAll(goldenDoc, BENCH_SPEC.row)) {
  for (const el of querySelectorAll(row, BENCH_SPEC.fields.price.selector)) {
    exemplars.push(exemplarOf(row, el));
  }
}
const liveRows = querySelectorAll(liveDoc, BENCH_SPEC.row);
const work = liveRows.reduce((n, r) => n + descendants(r).length, 0);
console.log(`${exemplars.length} exemplars, ${liveRows.length} rows, ${work} elements scored per pass\n`);

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function bench(name, fn, iters = 15) {
  for (let i = 0; i < 3; i++) fn();
  const t = [];
  for (let i = 0; i < iters; i++) {
    const t0 = performance.now();
    fn();
    t.push(performance.now() - t0);
  }
  const med = median(t);
  console.log(`${name.padEnd(34)} median ${med.toFixed(3).padStart(8)} ms  (n=${iters})`);
  return med;
}

let sink = 0;
const inline = bench("modal inside scoreElement", () => {
  for (const row of liveRows) for (const el of descendants(row)) sink += scoreElementInline(el, row, exemplars);
});
const hoisted = bench("modal hoisted out of the loop", () => {
  const m = { tag: MODALS.tag(exemplars), classes: MODALS.classes(exemplars), path: MODALS.path(exemplars) };
  for (const row of liveRows) for (const el of descendants(row)) sink += scoreElementHoisted(el, row, exemplars, m);
});
console.log(`\nspeedup ${(inline / hoisted).toFixed(1)}x   (checksum ${sink.toFixed(2)})`);
