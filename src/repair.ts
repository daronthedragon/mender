import { type ElementNode, parse } from "./html.js";
import { classify, shouldRepair } from "./classify.js";
import { brokenFields, rowCountBroken, validate } from "./contract.js";
import { extract, toRows } from "./extract.js";
import { fetchPage } from "./fetch.js";
import { type LoadedFixture, loadFixtures } from "./fixtures.js";
import { ROW_TARGET, propose } from "./propose.js";
import { applyCandidate, firstVerified } from "./verify.js";
import type { CheckResult, ScraperSpec, VerifiedCandidate } from "./types.js";

export interface RunOptions {
  /** Use this HTML instead of fetching. Keeps runs offline and reproducible. */
  html?: string;
  timeoutMs?: number;
}

export async function runCheck(spec: ScraperSpec, opts: RunOptions = {}): Promise<CheckResult> {
  const fetched =
    opts.html !== undefined
      ? { status: 200, finalUrl: spec.url, html: opts.html, ms: 0 }
      : await fetchPage(spec.url, { timeoutMs: opts.timeoutMs });

  const doc = parse(fetched.html);
  const extracted = extract(doc, spec);
  const violations = validate(extracted, spec);
  const { cause, detail } = classify(fetched, doc, spec, violations);

  return { spec, fetched, rows: toRows(extracted), violations, cause, causeDetail: detail };
}

export interface RepairOptions extends RunOptions {
  fixturesRoot: string;
}

export interface Rejection {
  target: string;
  selector: string;
  failedGate: string;
  detail: string;
}

export interface RepairOutcome {
  check: CheckResult;
  attempted: boolean;
  skippedReason: string | null;
  fixes: VerifiedCandidate[];
  unresolved: string[];
  rejectedCount: number;
  /** The nearest misses, so a human can see what was considered and why not. */
  rejections: Rejection[];
  /** Fixtures excluded because they no longer pass the current spec. */
  staleFixtures: string[];
  patched: ScraperSpec | null;
}

export async function runRepair(
  spec: ScraperSpec,
  opts: RepairOptions,
): Promise<RepairOutcome> {
  const check = await runCheck(spec, opts);
  const base: RepairOutcome = {
    check,
    attempted: false,
    skippedReason: null,
    fixes: [],
    unresolved: [],
    rejectedCount: 0,
    rejections: [],
    staleFixtures: [],
    patched: null,
  };

  if (check.cause === "OK") return { ...base, skippedReason: "contract already passes" };

  if (!shouldRepair(check.cause)) {
    // The whole point: a blocked or moved page must never rewrite a selector.
    return {
      ...base,
      skippedReason: `cause is ${check.cause} (${check.causeDetail}) — selectors left untouched`,
    };
  }

  const all = loadFixtures(opts.fixturesRoot, spec.name);
  const usable: LoadedFixture[] = [];
  const stale: string[] = [];
  for (const f of all) {
    const v = validate(extract(f.doc, spec), spec);
    if (v.length === 0) usable.push(f);
    else stale.push(f.source);
  }

  if (usable.length === 0) {
    return {
      ...base,
      staleFixtures: stale,
      skippedReason:
        all.length === 0
          ? "no fixtures to learn from — run `mender fixture add` while the scraper still works"
          : `all ${all.length} fixtures already fail the current spec, so there is no known-good reference`,
    };
  }

  const liveDoc = parse(check.fetched.html);
  const live = { source: "live", doc: liveDoc };
  const goldens = usable.map((f) => ({ source: f.source, doc: f.doc as ElementNode }));

  let working = spec;
  const fixes: VerifiedCandidate[] = [];
  const unresolved: string[] = [];
  const rejections: Rejection[] = [];
  let rejectedCount = 0;

  const recordMisses = (target: string, tried: VerifiedCandidate[]) => {
    for (const t of tried.slice(0, 3)) {
      const gate = t.passes.find((pass) => !pass.ok);
      if (gate) {
        rejections.push({
          target,
          selector: t.proposed,
          failedGate: gate.source,
          detail: gate.detail,
        });
      }
    }
  };

  // The row selector has to be right before any field selector can be judged.
  if (rowCountBroken(check.violations) && spec.row) {
    const candidates = propose({ spec: working, liveDoc, goldenDocs: goldens, target: ROW_TARGET });
    const { accepted, tried } = firstVerified(working, candidates, live, goldens);
    rejectedCount += tried.length - (accepted ? 1 : 0);
    if (accepted) {
      fixes.push(accepted);
      working = applyCandidate(working, accepted);
    } else {
      unresolved.push(ROW_TARGET);
      recordMisses(ROW_TARGET, tried);
    }
  }

  // Re-derive which fields are broken under the (possibly repaired) row selector.
  const afterRow = validate(extract(liveDoc, working), working);
  for (const field of brokenFields(afterRow)) {
    const candidates = propose({
      spec: working,
      liveDoc,
      goldenDocs: goldens,
      target: field,
      ...(working.row ? { liveRowSelector: working.row } : {}),
    });
    const { accepted, tried } = firstVerified(working, candidates, live, goldens);
    rejectedCount += tried.length - (accepted ? 1 : 0);
    if (accepted) {
      fixes.push(accepted);
      working = applyCandidate(working, accepted);
    } else {
      unresolved.push(field);
      recordMisses(field, tried);
    }
  }

  return {
    check,
    attempted: true,
    skippedReason: null,
    fixes,
    unresolved,
    rejectedCount,
    rejections,
    staleFixtures: stale,
    patched: fixes.length > 0 ? working : null,
  };
}
