import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadSpecs } from "./config.js";
import { scrape, type ScrapeResult } from "./api.js";
import {
  type NotifyEvent,
  type Notification,
  type Notifier,
  dispatch,
  headline,
} from "./notify.js";
import type { MenderSettings } from "./settings.js";
import type { ScraperSpec } from "./types.js";

/**
 * The supervisor. Runs every scraper on a cycle, repairs what it can, and tells
 * somebody — but only when the situation actually changed.
 *
 * Notifying every cycle is how a monitor gets muted, and a muted monitor
 * protects nothing. State is therefore keyed on the *condition*, not the run:
 * the same break stays quiet until it changes, is repaired, or recovers.
 */

export interface ScraperState {
  condition: string;
  cause: string;
  since: string;
  lastRun: string;
  consecutiveFailures: number;
  /** Cycles still to skip, from backing off a blocked or persistently failing target. */
  cooldown: number;
  notifiedCondition: string | null;
}

export type WatchState = Record<string, ScraperState>;

export const STATE_FILE = ".mender-state.json";

export function loadState(path: string): WatchState {
  if (!existsSync(path)) return {};
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as WatchState;
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    // A corrupt state file must not stop the supervisor; the cost is one
    // duplicate notification, which is far cheaper than a stalled watcher.
    return {};
  }
}

export function saveState(path: string, state: WatchState): void {
  mkdirSync(dirname(path) || ".", { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2) + "\n");
}

/**
 * A stable description of "what is wrong right now". Two runs with the same
 * condition are the same incident; a change means something new happened and is
 * worth interrupting a human for.
 */
export function conditionOf(result: ScrapeResult): string {
  if (result.ok && result.drift.length === 0) return "ok";
  if (result.ok) {
    return `drift:${result.drift.map((d) => `${d.field}/${d.code}`).sort().join(",")}`;
  }
  const targets = result.unhealed.length > 0 ? result.unhealed.slice().sort().join(",") : "-";
  return `${result.cause}:${targets}`;
}

export function eventFor(result: ScrapeResult, previous: ScraperState | undefined): NotifyEvent | null {
  const wasBroken = previous ? previous.condition !== "ok" && !previous.condition.startsWith("drift") : false;

  if (result.healed.length > 0 && result.ok) return "repaired";
  if (result.ok) {
    if (result.drift.length > 0) return "drift";
    return wasBroken ? "recovered" : null;
  }
  if (result.cause === "BLOCKED") return "blocked";
  if (result.healed.length === 0 && result.unhealed.length > 0) return "unrepaired";
  return "broken";
}

function detailFor(result: ScrapeResult, event: NotifyEvent): string {
  switch (event) {
    case "repaired":
      return `${result.healed.length} selector(s) repaired and verified; ${result.rows.length} rows extracted.`;
    case "recovered":
      return `Back to ${result.rows.length} rows with no violations.`;
    case "drift":
      return `The contract passes, but ${result.drift.length} value signal(s) moved.`;
    case "blocked":
      return `${result.causeDetail}. Selectors were left untouched.`;
    case "unrepaired":
      return `${result.causeDetail}. No candidate passed verification for: ${result.unhealed.join(", ")}.`;
    default:
      return result.causeDetail;
  }
}

export function notificationFor(
  spec: ScraperSpec,
  result: ScrapeResult,
  event: NotifyEvent,
  ts: string,
): Notification {
  return {
    event,
    scraper: spec.name,
    url: spec.url,
    ts,
    cause: result.cause,
    detail: detailFor(result, event),
    rows: result.rows.length,
    ...(result.healed.length > 0 ? { fixes: result.healed } : {}),
    ...(result.drift.length > 0 ? { drift: result.drift } : {}),
  };
}

/** Back off a target that keeps failing, so a blocked site is not hammered. */
export function cooldownFor(consecutiveFailures: number, cause: string): number {
  if (cause === "BLOCKED") return Math.min(8, 2 ** Math.min(consecutiveFailures, 3));
  if (consecutiveFailures >= 4) return Math.min(4, consecutiveFailures - 3);
  return 0;
}

async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return out;
}

export interface CycleOptions {
  settings: MenderSettings;
  notifiers: Notifier[];
  statePath?: string;
  /** Send even when the condition is unchanged. Used by `--notify-always`. */
  alwaysNotify?: boolean;
  now?: () => Date;
  onLine?: (line: string) => void;
  /** Test seam: replaces the real scrape call. */
  scraper?: typeof scrape;
}

export interface CycleEntry {
  name: string;
  skipped: boolean;
  condition: string;
  event: NotifyEvent | null;
  notified: boolean;
  rows: number;
  healed: number;
  result?: ScrapeResult;
}

export interface CycleReport {
  ts: string;
  entries: CycleEntry[];
  ok: number;
  broken: number;
  repaired: number;
  notificationsSent: number;
  notificationFailures: { notifier: string; error: string }[];
}

/** One pass over every spec. This is what `watch` calls on a timer, and what
 *  `watch --once` runs for a cron that already exists. */
export async function runCycle(opts: CycleOptions): Promise<CycleReport> {
  const settings = opts.settings;
  const scrapersDir = settings.scrapers ?? "scrapers";
  const fixtures = settings.fixtures ?? "fixtures";
  const statePath = opts.statePath ?? join(fixtures, STATE_FILE);
  const now = opts.now ?? (() => new Date());
  const say = opts.onLine ?? (() => {});
  const run = opts.scraper ?? scrape;

  const state = loadState(statePath);
  const specs = loadSpecs(scrapersDir);
  const ts = now().toISOString();
  const failures: { notifier: string; error: string }[] = [];

  const entries = await pool(specs, settings.concurrency ?? 4, async ({ path, spec }): Promise<CycleEntry> => {
    const previous = state[spec.name];

    if (previous && previous.cooldown > 0) {
      state[spec.name] = { ...previous, cooldown: previous.cooldown - 1 };
      say(`  ${spec.name}: skipped (cooling down, ${previous.cooldown - 1} cycle(s) left)`);
      return { name: spec.name, skipped: true, condition: previous.condition, event: null, notified: false, rows: 0, healed: 0 };
    }

    let result: ScrapeResult;
    try {
      // The PATH, not the loaded object: heal:"write" has to know which file to
      // rewrite, and re-reading each cycle means a repair written last cycle is
      // picked up on this one.
      result = await run(path, {
        fixtures,
        ...(settings.history ? { history: settings.history } : {}),
        ...(settings.record ? { record: true } : {}),
        ...(settings.heal !== undefined ? { heal: settings.heal } : {}),
        ...(settings.model ? { model: true } : {}),
      });
    } catch (e) {
      say(`  ${spec.name}: error — ${(e as Error).message}`);
      const failCount = (previous?.consecutiveFailures ?? 0) + 1;
      state[spec.name] = {
        condition: `ERROR:${(e as Error).message.slice(0, 80)}`,
        cause: "ERROR",
        since: previous?.since ?? ts,
        lastRun: ts,
        consecutiveFailures: failCount,
        cooldown: cooldownFor(failCount, "ERROR"),
        notifiedCondition: previous?.notifiedCondition ?? null,
      };
      return { name: spec.name, skipped: false, condition: "ERROR", event: null, notified: false, rows: 0, healed: 0 };
    }

    const condition = conditionOf(result);
    const event = eventFor(result, previous);
    const changed = previous?.notifiedCondition !== condition;
    const shouldFire = Boolean(event) && (opts.alwaysNotify || changed);

    let notified = false;
    if (event && shouldFire && opts.notifiers.length > 0) {
      const outcome = await dispatch(opts.notifiers, notificationFor(spec, result, event, ts));
      failures.push(...outcome.failed);
      notified = outcome.sent.length > 0;
    }

    const failCount = result.ok ? 0 : (previous?.consecutiveFailures ?? 0) + 1;
    state[spec.name] = {
      condition,
      cause: result.cause,
      since: previous?.condition === condition ? (previous.since ?? ts) : ts,
      lastRun: ts,
      consecutiveFailures: failCount,
      cooldown: result.ok ? 0 : cooldownFor(failCount, result.cause),
      notifiedCondition: notified || (event && shouldFire) ? condition : (previous?.notifiedCondition ?? null),
    };

    const mark = result.ok ? (result.healed.length > 0 ? "repaired" : "ok") : result.cause.toLowerCase();
    say(
      `  ${spec.name}: ${mark}` +
        (result.rows.length ? ` · ${result.rows.length} rows` : "") +
        (event ? ` · ${event}${notified ? " (notified)" : changed ? "" : " (already reported)"}` : ""),
    );

    return {
      name: spec.name,
      skipped: false,
      condition,
      event,
      notified,
      rows: result.rows.length,
      healed: result.healed.length,
      result,
    };
  });

  saveState(statePath, state);

  const live = entries.filter((e) => !e.skipped);
  return {
    ts,
    entries,
    ok: live.filter((e) => e.condition === "ok").length,
    broken: live.filter((e) => e.condition !== "ok" && !e.condition.startsWith("drift")).length,
    repaired: live.filter((e) => e.healed > 0).length,
    notificationsSent: entries.filter((e) => e.notified).length,
    notificationFailures: failures,
  };
}

export interface WatchOptions extends CycleOptions {
  /** Stop after this many cycles. Omit to run until interrupted. */
  maxCycles?: number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Loop until stopped. Returns the reports it produced, newest last. */
export async function watch(opts: WatchOptions): Promise<CycleReport[]> {
  const intervalMs = (opts.settings.interval ?? 900) * 1000;
  const sleep = opts.sleep ?? defaultSleep;
  const say = opts.onLine ?? (() => {});
  const reports: CycleReport[] = [];

  for (let cycle = 0; opts.maxCycles === undefined || cycle < opts.maxCycles; cycle++) {
    const report = await runCycle(opts);
    reports.push(report);
    say(
      `cycle ${cycle + 1}: ${report.ok} ok, ${report.broken} broken, ` +
        `${report.repaired} repaired, ${report.notificationsSent} notification(s)`,
    );
    for (const f of report.notificationFailures) {
      say(`  notifier ${f.notifier} failed: ${f.error}`);
    }
    const last = opts.maxCycles !== undefined && cycle === opts.maxCycles - 1;
    if (!last) await sleep(intervalMs);
  }
  return reports;
}

export function summariseCycle(report: CycleReport): string {
  const parts = [`${report.ok} ok`];
  if (report.repaired > 0) parts.push(`${report.repaired} repaired`);
  if (report.broken > 0) parts.push(`${report.broken} broken`);
  const skipped = report.entries.filter((e) => e.skipped).length;
  if (skipped > 0) parts.push(`${skipped} cooling down`);
  return parts.join(", ");
}

export { headline };
