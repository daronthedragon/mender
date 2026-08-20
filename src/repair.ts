import { type ElementNode, parse } from "./html.js";
import { classify, shouldRepair } from "./classify.js";
import { brokenFields, rowCountBroken, validate } from "./contract.js";
import { type ExtractedRow, extract, toRows } from "./extract.js";
import { AuthError, fetchPages } from "./fetch.js";
import type { PageFetcher } from "./browser.js";
import { type LoadedFixture, loadFixtures } from "./fixtures.js";
import {
  type DriftFinding,
  type DriftOptions,
  type RunRecord,
  appendRun,
  detectDrift,
  loadHistory,
  summarise,
} from "./history.js";
import { type ModelClient, proposeWithModel } from "./llm.js";
import { ROW_TARGET, propose } from "./propose.js";
import { applyCandidate, firstVerified } from "./verify.js";
import type { Candidate, CheckResult, FetchResult, ScraperSpec, VerifiedCandidate } from "./types.js";

export interface RunOptions {
  /** Use this HTML instead of fetching. Keeps runs offline and reproducible. */
  html?: string;
  timeoutMs?: number;
  /** Where run history lives, enabling drift detection. */
  historyRoot?: string;
  /** Append this run to the history file. */
  record?: boolean;
  drift?: DriftOptions;
  /** Seed the drift baseline from archived fixtures here. Defaults to historyRoot. */
  baselineFrom?: string;
  /** Render through a browser. Supplied by the caller; absent means plain fetch. */
  fetcher?: PageFetcher | null;
  now?: Date;
}

function reindex(rows: ExtractedRow[]): ExtractedRow[] {
  return rows.map((r, index) => ({ ...r, index }));
}

/**
 * A brand-new scraper has no run history, so drift would stay blind for its
 * first few runs — exactly the window in which a fresh spec is most likely to
 * be subtly wrong. Archived fixtures are already dated observations of the same
 * page, so they seed the baseline. Only fixtures that still pass are used: a
 * failing one would contribute nonsense statistics.
 */
export function withFixtureBaseline(
  history: RunRecord[],
  spec: ScraperSpec,
  fixturesRoot: string | undefined,
  minHistory: number,
): RunRecord[] {
  if (!fixturesRoot || history.length >= minHistory) return history;

  const seeded: RunRecord[] = [];
  for (const f of loadFixtures(fixturesRoot, spec.name)) {
    const rows = extract(f.doc, spec);
    if (validate(rows, spec).length > 0) continue;
    const ts = `fixture:${f.source}`;
    if (history.some((h) => h.ts === ts)) continue;
    seeded.push(summarise(rows, spec, ts));
  }
  return [...seeded, ...history];
}

export async function runCheck(spec: ScraperSpec, opts: RunOptions = {}): Promise<CheckResult> {
  let pages: FetchResult[];
  let primary: FetchResult;

  if (opts.html !== undefined) {
    primary = { status: 200, finalUrl: spec.url, html: opts.html, ms: 0 };
    pages = [primary];
  } else {
    try {
      const fetched = await fetchPages(spec, {
        ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
        ...(opts.fetcher ? { fetcher: opts.fetcher } : {}),
      });
      primary = fetched.primary;
      pages = fetched.pages;
    } catch (e) {
      // A misconfigured credential must be loud and must never look like a
      // layout change, so it is reported as an error cause rather than thrown.
      const detail = e instanceof AuthError ? e.message : `fetch failed: ${(e as Error).message}`;
      primary = { status: 0, finalUrl: spec.url, html: `<!-- ${detail} -->`, ms: 0 };
      return {
        spec,
        fetched: primary,
        pages: [primary],
        rows: [],
        violations: [],
        cause: "HTTP_ERROR",
        causeDetail: detail,
        drift: [],
      };
    }
  }

  const primaryDoc = parse(primary.html);
  const extracted = reindex(
    pages.flatMap((p) => extract(p === primary ? primaryDoc : parse(p.html), spec)),
  );
  const violations = validate(extracted, spec);
  const { cause, detail } = classify(primary, primaryDoc, spec, violations, extracted.length);

  let drift: DriftFinding[] = [];
  if (opts.historyRoot) {
    const ts = (opts.now ?? new Date()).toISOString();
    const record = summarise(extracted, spec, ts);
    // Drift is only meaningful when the structure is sound; a broken selector
    // would otherwise report itself as a dramatic change in meaning.
    if (cause === "OK") {
      const history = withFixtureBaseline(
        loadHistory(opts.historyRoot, spec.name),
        spec,
        opts.baselineFrom ?? opts.historyRoot,
        opts.drift?.minHistory ?? 3,
      );
      drift = detectDrift(history, record, opts.drift ?? {});
      if (opts.record) appendRun(opts.historyRoot, spec.name, record);
    }
  }

  return {
    spec,
    fetched: primary,
    pages,
    rows: toRows(extracted),
    violations,
    cause,
    causeDetail: detail,
    drift,
  };
}

export interface RepairOptions extends RunOptions {
  fixturesRoot: string;
  /** When the heuristics come up empty, ask a model. Optional by design. */
  model?: ModelClient | null;
}

export interface Rejection {
  target: string;
  selector: string;
  via: string;
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
  /** Whether a model was consulted at all. */
  modelUsed: string | null;
  patched: ScraperSpec | null;
}

export async function runRepair(spec: ScraperSpec, opts: RepairOptions): Promise<RepairOutcome> {
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
    modelUsed: null,
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
          ? "no fixtures to learn from — run `mender fixture` while the scraper still works"
          : `all ${all.length} fixtures already fail the current spec, so there is no known-good reference. Retire them with \`mender fixture --prune\` once you have a fresh one.`,
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
  let modelUsed: string | null = null;

  // Cap per proposer, not globally: otherwise a long list of heuristic misses
  // hides the model's, which is the one a human most wants to see.
  const PER_PROPOSER = 3;
  const recordMisses = (target: string, tried: VerifiedCandidate[]) => {
    const counts = new Map<string, number>();
    for (const t of tried) {
      const via = t.via ?? "heuristic";
      const seen = counts.get(via) ?? 0;
      if (seen >= PER_PROPOSER) continue;
      const gate = t.passes.find((pass) => !pass.ok);
      if (!gate) continue;
      counts.set(via, seen + 1);
      rejections.push({
        target,
        selector: t.proposed,
        via,
        failedGate: gate.source,
        detail: gate.detail,
      });
    }
  };

  /**
   * Heuristics first — they are free, deterministic, and handle the common
   * cases. The model is a fallback for the ones they cannot see, and it earns
   * nothing by being a model: its proposals face the identical three gates.
   */
  const attempt = async (target: string): Promise<VerifiedCandidate | null> => {
    const proposalInput = {
      spec: working,
      liveDoc,
      goldenDocs: goldens,
      target,
      ...(target !== ROW_TARGET && working.row ? { liveRowSelector: working.row } : {}),
    };

    const heuristic: Candidate[] = propose(proposalInput).map((c) => ({ ...c, via: "heuristic" }));
    const first = firstVerified(working, heuristic, live, goldens);
    let tried = first.tried;
    let accepted = first.accepted;

    if (!accepted && opts.model) {
      modelUsed = opts.model.name;
      const already = new Set(heuristic.map((c) => c.selector));
      const fromModel = (await proposeWithModel(opts.model, proposalInput))
        .filter((c) => !already.has(c.selector))
        .map((c) => ({ ...c, via: opts.model!.name }));
      const second = firstVerified(working, fromModel, live, goldens);
      tried = [...tried, ...second.tried];
      accepted = second.accepted;
    }

    rejectedCount += tried.length - (accepted ? 1 : 0);
    if (accepted) {
      fixes.push(accepted);
      working = applyCandidate(working, accepted);
      return accepted;
    }
    unresolved.push(target);
    recordMisses(target, tried);
    return null;
  };

  // The row selector has to be right before any field selector can be judged.
  if (rowCountBroken(check.violations) && spec.row) {
    await attempt(ROW_TARGET);
  }

  // Re-derive which fields are broken under the (possibly repaired) row selector.
  const afterRow = validate(extract(liveDoc, working), working);
  for (const field of brokenFields(afterRow)) {
    await attempt(field);
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
    modelUsed,
    patched: fixes.length > 0 ? working : null,
  };
}
