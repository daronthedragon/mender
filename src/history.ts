import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtractedRow } from "./extract.js";
import { kindOf } from "./verify.js";
import type { ScraperSpec } from "./types.js";

/**
 * Semantic drift is the failure the contract cannot see. If a price starts
 * including tax, every selector still matches, every type still parses, every
 * gate passes — and the number is wrong. Structure is checked per run; meaning
 * can only be checked against the past.
 */
export interface FieldStats {
  n: number;
  nulls: number;
  kinds: Record<string, number>;
  median?: number;
  min?: number;
  max?: number;
}

export interface RunRecord {
  ts: string;
  rows: number;
  fields: Record<string, FieldStats>;
}

export function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

export function summarise(rows: ExtractedRow[], spec: ScraperSpec, ts: string): RunRecord {
  const fields: Record<string, FieldStats> = {};

  for (const [name, field] of Object.entries(spec.fields)) {
    const stats: FieldStats = { n: 0, nulls: 0, kinds: {} };
    const numbers: number[] = [];

    for (const row of rows) {
      const cell = row.fields[name];
      const value = cell?.value ?? null;
      if (value === null || (Array.isArray(value) && value.length === 0)) {
        stats.nulls++;
        continue;
      }
      stats.n++;
      if (field.type === "list") {
        const k = `items-${Array.isArray(value) ? value.length : 0}`;
        stats.kinds[k] = (stats.kinds[k] ?? 0) + 1;
      } else {
        const k = kindOf(cell?.raw ?? "");
        stats.kinds[k] = (stats.kinds[k] ?? 0) + 1;
        if (typeof value === "number") numbers.push(value);
      }
    }

    if (numbers.length > 0) {
      stats.median = median(numbers);
      stats.min = Math.min(...numbers);
      stats.max = Math.max(...numbers);
    }
    fields[name] = stats;
  }

  return { ts, rows: rows.length, fields };
}

export function historyPath(root: string, name: string): string {
  return join(root, name, "history.jsonl");
}

export function appendRun(root: string, name: string, record: RunRecord): void {
  const path = historyPath(root, name);
  mkdirSync(join(root, name), { recursive: true });
  appendFileSync(path, JSON.stringify(record) + "\n");
}

export function loadHistory(root: string, name: string, limit = 30): RunRecord[] {
  const path = historyPath(root, name);
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, "utf8").split("\n").filter((l) => l.trim());
  const out: RunRecord[] = [];
  for (const line of lines.slice(-limit)) {
    try {
      out.push(JSON.parse(line) as RunRecord);
    } catch {
      // A corrupt line is skipped rather than failing the run.
    }
  }
  return out;
}

/** Keep the history file bounded without losing the baseline. */
export function pruneHistory(root: string, name: string, keep: number): number {
  const path = historyPath(root, name);
  if (!existsSync(path)) return 0;
  const lines = readFileSync(path, "utf8").split("\n").filter((l) => l.trim());
  if (lines.length <= keep) return 0;
  const dropped = lines.length - keep;
  writeFileSync(path, lines.slice(-keep).join("\n") + "\n");
  return dropped;
}

export interface DriftFinding {
  field: string;
  code: "KIND_SHIFT" | "MAGNITUDE_SHIFT" | "ROW_COUNT_SHIFT" | "NULL_RATE_SHIFT";
  detail: string;
}

export interface DriftOptions {
  /** Relative change in a field's median that counts as drift. */
  medianShift?: number;
  /** Relative change in row count that counts as drift. */
  rowShift?: number;
  /** Runs required before drift is judged at all. */
  minHistory?: number;
}

function dominantKind(kinds: Record<string, number>): string | null {
  let best: [string, number] | null = null;
  for (const entry of Object.entries(kinds)) {
    if (!best || entry[1] > best[1]) best = entry;
  }
  return best?.[0] ?? null;
}

/**
 * Compare the latest run against the runs before it. Deliberately separate from
 * contract validation: drift is a warning for a human, never a trigger for an
 * automatic selector repair. Repairing a selector because a price started
 * including tax would be exactly the wrong move.
 */
export function detectDrift(
  history: RunRecord[],
  current: RunRecord,
  opts: DriftOptions = {},
): DriftFinding[] {
  // 0.15 rather than something looser: a 20% VAT change is exactly the kind
  // of silent shift this exists to catch, and a warning costs nothing.
  const medianShift = opts.medianShift ?? 0.15;
  const rowShift = opts.rowShift ?? 0.5;
  const minHistory = opts.minHistory ?? 3;

  const baseline = history.filter((r) => r.ts !== current.ts);
  if (baseline.length < minHistory) return [];

  const findings: DriftFinding[] = [];

  const baseRows = median(baseline.map((r) => r.rows)) ?? 0;
  if (baseRows > 0) {
    const delta = Math.abs(current.rows - baseRows) / baseRows;
    if (delta > rowShift) {
      findings.push({
        field: "__rows__",
        code: "ROW_COUNT_SHIFT",
        detail: `row count ${current.rows} against a baseline median of ${baseRows} (${Math.round(delta * 100)}% change)`,
      });
    }
  }

  for (const [name, stats] of Object.entries(current.fields)) {
    const past = baseline.map((r) => r.fields[name]).filter((s): s is FieldStats => Boolean(s));
    if (past.length < minHistory) continue;

    const pastKinds: Record<string, number> = {};
    for (const p of past) {
      for (const [k, n] of Object.entries(p.kinds)) pastKinds[k] = (pastKinds[k] ?? 0) + n;
    }
    const wasKind = dominantKind(pastKinds);
    const isKind = dominantKind(stats.kinds);
    if (wasKind && isKind && wasKind !== isKind) {
      findings.push({
        field: name,
        code: "KIND_SHIFT",
        detail: `values now read as ${isKind}, historically ${wasKind}`,
      });
    }

    const pastMedians = past.map((p) => p.median).filter((m): m is number => typeof m === "number");
    const baseMedian = median(pastMedians);
    if (baseMedian !== undefined && baseMedian !== 0 && typeof stats.median === "number") {
      const delta = Math.abs(stats.median - baseMedian) / Math.abs(baseMedian);
      if (delta > medianShift) {
        const direction = stats.median > baseMedian ? "up" : "down";
        findings.push({
          field: name,
          code: "MAGNITUDE_SHIFT",
          detail: `median ${stats.median} is ${Math.round(delta * 100)}% ${direction} from a baseline of ${baseMedian}`,
        });
      }
    }

    const pastNullRate =
      past.reduce((acc, p) => acc + p.nulls / Math.max(1, p.n + p.nulls), 0) / past.length;
    const nullRate = stats.nulls / Math.max(1, stats.n + stats.nulls);
    if (nullRate - pastNullRate > 0.3) {
      findings.push({
        field: name,
        code: "NULL_RATE_SHIFT",
        detail: `${Math.round(nullRate * 100)}% of values are now empty, historically ${Math.round(pastNullRate * 100)}%`,
      });
    }
  }

  return findings;
}
