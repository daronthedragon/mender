import type { ElementNode } from "./html.js";
import { extract, toRows } from "./extract.js";
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
  passes.push({
    source: live.source,
    ok: stillBroken.length === 0,
    detail:
      stillBroken.length === 0
        ? `${extract(live.doc, patched).length} rows pass for ${candidate.target}`
        : stillBroken[0]!.detail,
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
