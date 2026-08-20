import { loadSpec, loadSpecs, patchSpecFile, validateSpec } from "./config.js";
import { runCheck, runRepair } from "./repair.js";
import { type PageFetcher, playwrightFetcher } from "./browser.js";
import type { ModelClient } from "./llm.js";
import { type ModelConfig, createModelClient } from "./providers.js";
import { saveFixture, todayStamp } from "./fixtures.js";
import { ROW_TARGET } from "./propose.js";
import type { DriftFinding } from "./history.js";
import type { Cause, Row, ScraperSpec, Violation } from "./types.js";

/**
 * The one-call surface. Everything below this file is composable if you want
 * it, but the common case is "give me the rows, and fix yourself if you can",
 * and that should not require assembling five modules by hand.
 */

export interface ScrapeOptions {
  /** Directory holding golden snapshots. Default "fixtures". */
  fixtures?: string;
  /** Directory holding run history for drift. Defaults to `fixtures`. */
  history?: string;
  /** Append this run to the history file, building the drift baseline. */
  record?: boolean;
  /**
   * What to do when the contract fails.
   *  false   - report only (default)
   *  true    - attempt a verified repair and use it for this run, in memory
   *  "write" - as above, and persist the repaired selectors to the spec file
   */
  heal?: boolean | "write";
  /**
   * Ask a model when the heuristics come up empty. `true` infers the provider
   * from the environment, an object pins one, or pass your own ModelClient.
   */
  model?: ModelClient | ModelConfig | boolean | null;
  /** Render with a browser. Also implied by a spec with a `render` block. */
  render?: boolean;
  /** Use this HTML instead of fetching. */
  html?: string;
  timeoutMs?: number;
  /** Archive the page as a fixture when the run is healthy and none exists yet. */
  archiveFirstRun?: boolean;
  /** Progress callback. Useful for logging inside a pipeline. */
  onEvent?: (event: MenderEvent) => void;
}

export type MenderEvent =
  | { type: "checked"; name: string; cause: Cause; rows: number }
  | { type: "healing"; name: string; cause: Cause }
  | { type: "healed"; name: string; target: string; selector: string; via: string }
  | { type: "unhealed"; name: string; target: string; reason: string }
  | { type: "drift"; name: string; findings: DriftFinding[] };

export interface HealedSelector {
  /** Field name, or "row" for the record selector. */
  target: string;
  from: string;
  to: string;
  via: string;
}

export interface ScrapeResult {
  /** True when the contract passed, before or after healing. */
  ok: boolean;
  rows: Row[];
  cause: Cause;
  causeDetail: string;
  violations: Violation[];
  drift: DriftFinding[];
  /** Selectors repaired during this run. Empty unless `heal` was enabled. */
  healed: HealedSelector[];
  /** Targets that broke and could not be repaired. */
  unhealed: string[];
  /** The spec actually used, including any in-memory repairs. */
  spec: ScraperSpec;
  pages: number;
}

export class MenderError extends Error {}

function label(target: string): string {
  return target === ROW_TARGET ? "row" : target;
}

function resolveModel(model: ScrapeOptions["model"]): ModelClient | null {
  if (!model) return null;
  if (model === true) return createModelClient();
  // A plain object is a provider config; anything with complete() is a client.
  if (typeof (model as ModelClient).complete === "function") return model as ModelClient;
  return createModelClient(model as ModelConfig);
}

/** Accepts a spec object, or a path to a spec file. */
export function resolveSpec(target: string | ScraperSpec): ScraperSpec {
  if (typeof target === "string") return loadSpec(target);
  return validateSpec(target, "inline spec");
}

/**
 * Run one scraper and get its rows back.
 *
 * With `heal` enabled a broken scraper repairs itself mid-run and still returns
 * data — but only through the same three verification gates the CLI uses, so a
 * repair that cannot be proved is refused and you get the failure instead of
 * quietly wrong rows.
 */
export async function scrape(
  target: string | ScraperSpec,
  opts: ScrapeOptions = {},
): Promise<ScrapeResult> {
  const specPath = typeof target === "string" ? target : null;
  const spec = resolveSpec(target);
  const fixtures = opts.fixtures ?? "fixtures";
  const history = opts.history ?? fixtures;
  const emit = opts.onEvent ?? (() => {});

  let fetcher: PageFetcher | null = null;
  const needsBrowser = Boolean(opts.render || spec.render);
  let ownsFetcher = false;

  try {
    if (needsBrowser && opts.html === undefined) {
      fetcher = await playwrightFetcher();
      ownsFetcher = true;
    }

    const runOptions = {
      historyRoot: history,
      baselineFrom: fixtures,
      ...(opts.record ? { record: true } : {}),
      ...(opts.html !== undefined ? { html: opts.html } : {}),
      ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
      ...(fetcher ? { fetcher } : {}),
    };

    const check = await runCheck(spec, runOptions);
    emit({ type: "checked", name: spec.name, cause: check.cause, rows: check.rows.length });
    if (check.drift.length > 0) {
      emit({ type: "drift", name: spec.name, findings: check.drift });
    }

    const base: ScrapeResult = {
      ok: check.cause === "OK",
      rows: check.rows,
      cause: check.cause,
      causeDetail: check.causeDetail,
      violations: check.violations,
      drift: check.drift,
      healed: [],
      unhealed: [],
      spec,
      pages: check.pages.length,
    };

    if (check.cause === "OK") {
      if (opts.archiveFirstRun && opts.html === undefined) {
        saveFixture(fixtures, spec.name, check.fetched.html, todayStamp());
      }
      return base;
    }

    if (!opts.heal) return base;

    emit({ type: "healing", name: spec.name, cause: check.cause });
    const outcome = await runRepair(spec, {
      ...runOptions,
      fixturesRoot: fixtures,
      model: resolveModel(opts.model),
    });

    const healed: HealedSelector[] = outcome.fixes.map((fix) => ({
      target: label(fix.target),
      from:
        fix.target === ROW_TARGET
          ? (spec.row ?? "")
          : (spec.fields[fix.target]?.selector ?? ""),
      to: fix.selector,
      via: fix.via ?? "heuristic",
    }));
    for (const h of healed) {
      emit({ type: "healed", name: spec.name, target: h.target, selector: h.to, via: h.via });
    }
    for (const t of outcome.unresolved) {
      const miss = outcome.rejections.find((r) => r.target === t);
      emit({
        type: "unhealed",
        name: spec.name,
        target: label(t),
        reason: miss ? `${miss.selector} rejected at ${miss.failedGate}: ${miss.detail}` : "no candidate proposed",
      });
    }

    if (!outcome.patched) {
      return {
        ...base,
        healed,
        unhealed: outcome.unresolved.map(label),
        ...(outcome.skippedReason ? { causeDetail: outcome.skippedReason } : {}),
      };
    }

    if (opts.heal === "write") {
      if (!specPath) {
        throw new MenderError('heal: "write" needs a spec file path, not an inline spec object');
      }
      for (const fix of outcome.fixes) patchSpecFile(specPath, fix.target, fix.selector);
    }

    // Re-run against the repaired spec so the caller gets real data, not a
    // promise that it would have worked.
    const after = await runCheck(outcome.patched, runOptions);
    return {
      ok: after.cause === "OK",
      rows: after.rows,
      cause: after.cause,
      causeDetail: after.causeDetail,
      violations: after.violations,
      drift: after.drift,
      healed,
      unhealed: outcome.unresolved.map(label),
      spec: outcome.patched,
      pages: after.pages.length,
    };
  } finally {
    if (ownsFetcher && fetcher) await fetcher.close();
  }
}

/** Run every spec in a directory. Ordering is stable, by filename. */
export async function scrapeAll(
  dir = "scrapers",
  opts: ScrapeOptions = {},
): Promise<Record<string, ScrapeResult>> {
  const out: Record<string, ScrapeResult> = {};
  for (const { path } of loadSpecs(dir)) {
    const result = await scrape(path, opts);
    out[result.spec.name] = result;
  }
  return out;
}

/**
 * Identity function that gives editors the spec type without a JSON schema.
 * `export default defineSpec({ ... })` in a .ts file, or use it inline.
 */
export function defineSpec(spec: ScraperSpec): ScraperSpec {
  return validateSpec(spec, "defineSpec");
}

/** Convenience: rows only, throwing if the contract is not satisfied. */
export async function rows(
  target: string | ScraperSpec,
  opts: ScrapeOptions = {},
): Promise<Row[]> {
  const result = await scrape(target, opts);
  if (!result.ok) {
    throw new MenderError(
      `${result.spec.name}: ${result.cause} — ${result.causeDetail}` +
        (result.unhealed.length > 0 ? ` (unrepaired: ${result.unhealed.join(", ")})` : ""),
    );
  }
  return result.rows;
}
