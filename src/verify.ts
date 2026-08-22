import type { ElementNode } from "./html.js";
import { extract, rowElements, toRows } from "./extract.js";
import { querySelectorAll } from "./select.js";
import { validate } from "./contract.js";
import { ROW_TARGET } from "./propose.js";
import type { Candidate, ScraperSpec, VerifiedCandidate, Violation } from "./types.js";

/**
 * A repair keeps the selector it replaces instead of overwriting it.
 *
 * After a real layout change the old markup is gone from the live page and the
 * new markup was never in the archived snapshots, so no single selector can
 * satisfy both. Union selectors resolve that: the old branch keeps matching the
 * pages that used to work, the new branch matches today's, and the archived
 * snapshots stay a usable regression gate instead of blocking every genuine fix.
 */
export function unionSelector(previous: string | undefined, proposed: string): string {
  if (!previous) return proposed;
  const parts = previous.split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.includes(proposed.trim())) return previous;
  return [...parts, proposed.trim()].join(", ");
}

export function currentSelector(spec: ScraperSpec, target: string): string | undefined {
  return target === ROW_TARGET ? spec.row : spec.fields[target]?.selector;
}

export function applyCandidate(spec: ScraperSpec, candidate: Candidate): ScraperSpec {
  if (candidate.target === ROW_TARGET) return { ...spec, row: candidate.selector };
  const field = spec.fields[candidate.target];
  if (!field) return spec;
  return {
    ...spec,
    fields: { ...spec.fields, [candidate.target]: { ...field, selector: candidate.selector } },
  };
}

function violationsOf(doc: ElementNode, spec: ScraperSpec): Violation[] {
  return validate(extract(doc, spec), spec);
}

function relevant(violations: Violation[], target: string): Violation[] {
  if (target === ROW_TARGET) return violations.filter((v) => v.code === "ROW_COUNT");
  return violations.filter((v) => v.field === target);
}

/**
 * A row selector that drags in something which is not a record.
 *
 * Judging a row repair on row COUNT alone let a candidate add a table's header
 * row to 1,595 real ones: the count stayed within expectations, the archive was
 * untouched because the new branch matched nothing there, and coverage was
 * unaffected — so every gate passed while the data gained a junk row reading
 * `{"domain": null, "type": "Domain"}`.
 *
 * The signature is a field that works in most rows and fails in a few. A field
 * failing in EVERY row is independently broken and must not block the row
 * repair, since the row is fixed first and the field is repaired after.
 */
function rowsAreRecords(
  doc: ElementNode,
  patched: ScraperSpec,
  violations: Violation[],
): { ok: boolean; detail: string } {
  const total = extract(doc, patched).length;
  if (total === 0) return { ok: true, detail: "no rows to judge" };

  const perField = new Map<string, Set<number>>();
  for (const v of violations) {
    if (!v.field || v.row === undefined) continue;
    const rows = perField.get(v.field) ?? new Set<number>();
    rows.add(v.row);
    perField.set(v.field, rows);
  }

  for (const [field, rows] of perField) {
    if (rows.size === 0 || rows.size === total) continue; // wholly broken field
    const share = rows.size / total;
    if (share < 0.5) {
      return {
        ok: false,
        detail:
          `${rows.size} of ${total} rows fail on ${field} while the rest pass — ` +
          "those rows are not records",
      };
    }
  }
  return { ok: true, detail: `all ${total} rows look like records` };
}

function snapshot(doc: ElementNode, spec: ScraperSpec): string {
  return JSON.stringify(toRows(extract(doc, spec)));
}

/**
 * The coarse kind of a value, used to tell "this is still a price" from "this is
 * a star rating that happens to be a number above 1". Deliberately blunt: a
 * price reformatted from "$19" to "$19.00" stays the same kind.
 */
const CURRENCY_WORDS =
  /\b(usd|eur|gbp|jpy|cad|aud|chf|cny|inr|dollars?|euros?|pounds?|yen|rupees?|cents?|pence)\b/i;

export function kindOf(text: string): string {
  const t = text.trim();
  if (!t) return "empty";
  if (/[$€£¥₹]/.test(t) || CURRENCY_WORDS.test(t)) return "currency";
  if (/^[\d.,\s%+\/-]+$/.test(t)) return "numeric";
  const words = t.split(/\s+/).length;
  return words <= 2 ? "words-short" : words <= 6 ? "words-mid" : "words-long";
}

function rawValues(doc: ElementNode, spec: ScraperSpec, target: string): string[] {
  return extract(doc, spec)
    .map((r) => r.fields[target]?.raw ?? "")
    .filter((s) => s.length > 0);
}

/**
 * Gate three. A candidate can clear the contract and leave archived pages
 * untouched while still being the wrong element, because the old branch of the
 * union simply matches nothing on the new page. Comparing the kind of value it
 * now yields against the kind it used to yield is what catches that.
 */
function continuityOk(
  spec: ScraperSpec,
  patched: ScraperSpec,
  target: string,
  live: ElementNode,
  goldens: { source: string; doc: ElementNode }[],
): { ok: boolean; detail: string } {
  if (target === ROW_TARGET) return { ok: true, detail: "not applicable to rows" };
  const field = spec.fields[target];
  if (!field || field.type === "list") return { ok: true, detail: "not applicable to lists" };

  const goldenKinds = new Set<string>();
  for (const g of goldens) for (const v of rawValues(g.doc, spec, target)) goldenKinds.add(kindOf(v));
  if (goldenKinds.size === 0) return { ok: true, detail: "no archived values to compare" };

  const liveRaw = rawValues(live, patched, target);
  if (liveRaw.length === 0) return { ok: false, detail: "repair produced no values" };

  const matching = liveRaw.filter((v) => goldenKinds.has(kindOf(v)));
  const ratio = matching.length / liveRaw.length;
  const liveKinds = [...new Set(liveRaw.map(kindOf))].join("/");
  if (ratio >= 0.5) return { ok: true, detail: `values still read as ${liveKinds}` };

  // Kind alone is too blunt on its own. A site reformatting "$19" to "19.00"
  // changes the kind while the value is plainly the same, and refusing that is
  // a false rejection that costs a human a manual fix. So fall back to the
  // magnitude: if the numbers themselves are continuous with the archive, the
  // reformat is accepted. The trap case stays rejected because a star rating is
  // not merely a differently-formatted price — it is a different number.
  const field2 = spec.fields[target];
  if (field2 && field2.type === "number") {
    const goldenNums: number[] = [];
    for (const g of goldens) {
      for (const v of numericValues(g.doc, spec, target)) goldenNums.push(v);
    }
    const liveNums = numericValues(live, patched, target);
    const before = mid(goldenNums);
    const after = mid(liveNums);
    if (before !== null && after !== null && before !== 0) {
      const delta = Math.abs(after - before) / Math.abs(before);
      if (delta <= MAGNITUDE_TOLERANCE) {
        return {
          ok: true,
          detail: `format changed to ${liveKinds} but the values are continuous (median ${after} against ${before})`,
        };
      }
      return {
        ok: false,
        detail: `values now read as ${liveKinds}, archived pages had ${[...goldenKinds].join("/")}, and the median moved ${Math.round(delta * 100)}% (${before} to ${after})`,
      };
    }
  }

  return {
    ok: false,
    detail: `values now read as ${liveKinds}, archived pages had ${[...goldenKinds].join("/")}`,
  };
}

/** How far a median may move before a reformat stops looking like a reformat. */
const MAGNITUDE_TOLERANCE = 0.25;

function numericValues(doc: ElementNode, spec: ScraperSpec, target: string): number[] {
  const out: number[] = [];
  for (const row of extract(doc, spec)) {
    const v = row.fields[target]?.value;
    if (typeof v === "number") out.push(v);
  }
  return out;
}

function mid(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** How far the captured fraction may fall before a repair is refused. */
const COVERAGE_TOLERANCE = 0.25;

/**
 * How many elements a field selector finds in the whole document, and how many
 * of those the row structure actually uses. A scalar field uses at most one per
 * row; a list uses all of them.
 */
function capture(doc: ElementNode, spec: ScraperSpec, field: string): { used: number; total: number } {
  const f = spec.fields[field];
  if (!f) return { used: 0, total: 0 };

  let total = 0;
  try {
    total = querySelectorAll(doc, f.selector).length;
  } catch {
    return { used: 0, total: 0 };
  }

  let used = 0;
  for (const row of rowElements(doc, spec)) {
    let hits = 0;
    try {
      hits = querySelectorAll(row, f.selector).length;
    } catch {
      hits = 0;
    }
    used += f.type === "list" ? hits : Math.min(1, hits);
  }
  return { used, total };
}

/**
 * Gate four. The first three ask whether each value is right; this asks whether
 * the records were carved up right.
 *
 * A row selector that groups two records per match produces rows that satisfy
 * everything else - the right kind of values, a plausible row count, archives
 * untouched because the new selector does not exist there - while silently
 * dropping half the page and mis-associating the rest. The symptom is that the
 * document still contains the field elements; the row structure just stopped
 * reaching them. Comparing the captured fraction against the archive catches it
 * without needing to know what the right grouping is.
 */
function coverageOk(
  spec: ScraperSpec,
  patched: ScraperSpec,
  live: ElementNode,
  goldens: { source: string; doc: ElementNode }[],
): { ok: boolean; detail: string } {
  if (goldens.length === 0) return { ok: true, detail: "no archive to compare capture against" };

  for (const field of Object.keys(spec.fields)) {
    const before: number[] = [];
    for (const g of goldens) {
      const c = capture(g.doc, spec, field);
      if (c.total > 0) before.push(c.used / c.total);
    }
    if (before.length === 0) continue;

    const after = capture(live, patched, field);
    if (after.total === 0) continue;

    const wasRatio = before.reduce((a, b) => a + b, 0) / before.length;
    const nowRatio = after.used / after.total;
    if (wasRatio - nowRatio > COVERAGE_TOLERANCE) {
      const missed = after.total - after.used;
      return {
        ok: false,
        detail:
          `the rows reach only ${after.used} of ${after.total} ${field} element(s) on the page ` +
          `(${Math.round(nowRatio * 100)}%, archives reached ${Math.round(wasRatio * 100)}%) ` +
          `- ${missed} record(s) would be silently dropped`,
      };
    }
  }
  return { ok: true, detail: "rows reach as much of the page as they used to" };
}

export interface VerifyInput {
  spec: ScraperSpec;
  candidate: Candidate;
  live: { source: string; doc: ElementNode };
  goldens: { source: string; doc: ElementNode }[];
}

/**
 * Three gates, all of which must pass.
 *
 * 1. live      — the union clears the violations it targets on today's page.
 * 2. archive   — on every stored snapshot the union extracts byte-identical
 *                data to what the spec extracted before the change.
 * 3. continuity — the values still read as the same kind of thing they used to.
 *
 * Gate 3 is not redundant. When a field is genuinely gone, a wrong element can
 * satisfy the contract on the live page while matching nothing on the archives,
 * which leaves gates 1 and 2 perfectly happy.
 */
export function verifyCandidate(input: VerifyInput): VerifiedCandidate {
  const { spec, candidate, live, goldens } = input;
  const union = unionSelector(currentSelector(spec, candidate.target), candidate.selector);
  const patched = applyCandidate(spec, { ...candidate, selector: union });
  const passes: VerifiedCandidate["passes"] = [];

  const fail = (source: string, detail: string): VerifiedCandidate => ({
    ...candidate,
    selector: union,
    proposed: candidate.selector,
    passes: [...passes, { source, ok: false, detail }],
    verified: false,
  });

  let liveViolations: Violation[];
  try {
    liveViolations = violationsOf(live.doc, patched);
  } catch (e) {
    return fail(live.source, `selector error: ${(e as Error).message}`);
  }

  const stillBroken = relevant(liveViolations, candidate.target);
  // A row repair is additionally judged on whether the rows it selects are
  // records at all, not merely on how many there are.
  const records =
    candidate.target === ROW_TARGET
      ? rowsAreRecords(live.doc, patched, liveViolations)
      : { ok: true, detail: "" };

  passes.push({
    source: live.source,
    ok: stillBroken.length === 0 && records.ok,
    detail:
      stillBroken.length > 0
        ? stillBroken[0]!.detail
        : records.ok
          ? `${extract(live.doc, patched).length} rows pass for ${candidate.target}`
          : records.detail,
  });

  for (const g of goldens) {
    try {
      const before = snapshot(g.doc, spec);
      const after = snapshot(g.doc, patched);
      const contractOk = violationsOf(g.doc, patched).length === 0;
      const identical = before === after;
      passes.push({
        source: g.source,
        ok: identical && contractOk,
        detail: identical
          ? contractOk
            ? `${extract(g.doc, patched).length} rows unchanged`
            : "contract broke on archived page"
          : "extracted values changed on an archived page",
      });
    } catch (e) {
      passes.push({ source: g.source, ok: false, detail: `selector error: ${(e as Error).message}` });
    }
  }

  const coverage = coverageOk(spec, patched, live.doc, goldens);
  passes.push({ source: "coverage", ok: coverage.ok, detail: coverage.detail });

  const continuity = continuityOk(spec, patched, candidate.target, live.doc, goldens);
  passes.push({ source: "continuity", ok: continuity.ok, detail: continuity.detail });

  return {
    ...candidate,
    selector: union,
    proposed: candidate.selector,
    passes,
    verified: passes.every((p) => p.ok),
  };
}

/** The first candidate that clears every gate, ranked by heuristic score. */
export function firstVerified(
  spec: ScraperSpec,
  candidates: Candidate[],
  live: { source: string; doc: ElementNode },
  goldens: { source: string; doc: ElementNode }[],
): { accepted: VerifiedCandidate | null; tried: VerifiedCandidate[] } {
  const tried: VerifiedCandidate[] = [];
  for (const candidate of candidates) {
    const result = verifyCandidate({ spec, candidate, live, goldens });
    tried.push(result);
    if (result.verified) return { accepted: result, tried };
  }
  return { accepted: null, tried };
}
