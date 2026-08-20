import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import type { Row, ScraperSpec } from "./types.js";

/**
 * Where the data goes.
 *
 * mender kept scrapers alive and then threw away everything they scraped:
 * `watch` read `rows.length` for a log line and discarded the rest, and
 * `extract` could only write to stdout. A monitor that repairs a scraper but
 * collects nothing has done half a job.
 *
 * The interesting mode is `changes`. Because a row has an identity across runs,
 * a price that moves from 19 to 21 can be recorded as an event with both sides,
 * rather than as two snapshots someone has to diff later.
 */

export type OutputFormat = "jsonl" | "json" | "csv";
export type OutputMode = "snapshot" | "append" | "changes";

export interface OutputConfig {
  /** Destination. `{name}` and `{date}` are substituted. */
  path: string;
  /** Defaults to the file extension, then jsonl. */
  format?: OutputFormat;
  /**
   *  snapshot - overwrite with the current rows (default)
   *  append   - add rows not seen before
   *  changes  - add an event per new or changed row, with both values
   */
  mode?: OutputMode;
  /** Field(s) identifying a record across runs. Without it, the whole row is the identity. */
  key?: string | string[];
}

export class SinkError extends Error {}

export interface ChangeCounts {
  added: number;
  updated: number;
  unchanged: number;
  removed: number;
}

export interface WriteResult {
  path: string;
  format: OutputFormat;
  mode: OutputMode;
  /** Records actually written this run. */
  written: number;
  changes: ChangeCounts;
}

export function resolvePath(template: string, spec: ScraperSpec, now: Date): string {
  return template
    .replace(/\{name\}/g, spec.name)
    .replace(/\{date\}/g, now.toISOString().slice(0, 10));
}

export function formatFor(path: string, explicit?: OutputFormat): OutputFormat {
  if (explicit) return explicit;
  const ext = extname(path).toLowerCase();
  if (ext === ".csv") return "csv";
  if (ext === ".json") return "json";
  return "jsonl";
}

/** Stable identity for a row, so the same record is recognised next run. */
export function keyOf(row: Row, key?: string | string[]): string {
  if (!key) return JSON.stringify(row);
  const fields = Array.isArray(key) ? key : [key];
  return JSON.stringify(fields.map((f) => row[f] ?? null));
}

function valueOf(row: Row): string {
  return JSON.stringify(row);
}

/* ---------- csv ---------- */

/** RFC 4180: quote when the value contains a delimiter, quote or newline. */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const s = Array.isArray(value) ? value.join("; ") : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows: Row[], columns: string[]): string {
  const lines = [columns.map(csvCell).join(",")];
  for (const row of rows) lines.push(columns.map((c) => csvCell(row[c])).join(","));
  return lines.join("\n") + "\n";
}

/* ---------- change tracking ---------- */

interface SeenStore {
  /** key -> the serialised row last seen under it. */
  rows: Record<string, string>;
  updatedAt: string;
}

export function storePath(stateDir: string, name: string): string {
  return join(stateDir, name, "rows.json");
}

export function loadSeen(stateDir: string, name: string): SeenStore {
  const path = storePath(stateDir, name);
  if (!existsSync(path)) return { rows: {}, updatedAt: "" };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as SeenStore;
    return parsed && typeof parsed.rows === "object" ? parsed : { rows: {}, updatedAt: "" };
  } catch {
    // A corrupt store costs one run of duplicates, not a crash.
    return { rows: {}, updatedAt: "" };
  }
}

export function saveSeen(stateDir: string, name: string, store: SeenStore): void {
  const path = storePath(stateDir, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(store, null, 2) + "\n");
}

export interface ChangeEvent {
  _change: "added" | "updated";
  _at: string;
  /** Field-level before/after, present only on an update. */
  _before?: Row;
  [field: string]: unknown;
}

export interface Diff {
  events: ChangeEvent[];
  counts: ChangeCounts;
  /** The store to persist if the write succeeds. */
  next: Record<string, string>;
}

/** Compare this run's rows against what was seen last time. */
export function diffRows(
  rows: Row[],
  seen: Record<string, string>,
  key: string | string[] | undefined,
  at: string,
): Diff {
  const events: ChangeEvent[] = [];
  const next: Record<string, string> = {};
  const counts: ChangeCounts = { added: 0, updated: 0, unchanged: 0, removed: 0 };

  for (const row of rows) {
    const k = keyOf(row, key);
    const now = valueOf(row);
    next[k] = now;

    const before = seen[k];
    if (before === undefined) {
      counts.added++;
      events.push({ _change: "added", _at: at, ...row });
    } else if (before !== now) {
      counts.updated++;
      events.push({ _change: "updated", _at: at, _before: JSON.parse(before) as Row, ...row });
    } else {
      counts.unchanged++;
    }
  }

  for (const k of Object.keys(seen)) {
    if (!(k in next)) counts.removed++;
  }
  return { events, counts, next };
}

/* ---------- writing ---------- */

export interface WriteOptions {
  /** Where the seen-rows store lives. Defaults beside the fixtures. */
  stateDir?: string;
  now?: Date;
}

export function writeRows(
  rows: Row[],
  spec: ScraperSpec,
  config: OutputConfig,
  opts: WriteOptions = {},
): WriteResult {
  const now = opts.now ?? new Date();
  const at = now.toISOString();
  const path = resolvePath(config.path, spec, now);
  const format = formatFor(path, config.format);
  const mode = config.mode ?? "snapshot";
  const stateDir = opts.stateDir ?? "fixtures";
  const columns = Object.keys(spec.fields);

  mkdirSync(dirname(path) || ".", { recursive: true });

  if (mode === "snapshot") {
    // A snapshot has no memory by design: the file is what the page says now.
    const body =
      format === "csv"
        ? toCsv(rows, columns)
        : format === "json"
          ? JSON.stringify(rows, null, 2) + "\n"
          : rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : "");
    writeFileSync(path, body);
    return {
      path,
      format,
      mode,
      written: rows.length,
      changes: { added: rows.length, updated: 0, unchanged: 0, removed: 0 },
    };
  }

  const store = loadSeen(stateDir, spec.name);
  const diff = diffRows(rows, store.rows, config.key, at);

  if (mode === "append") {
    // Only rows never seen before; an unchanged row is not appended again.
    const fresh = diff.events.filter((e) => e._change === "added").map((e) => {
      const { _change, _at, _before, ...row } = e;
      void _change;
      void _at;
      void _before;
      return row as Row;
    });
    appendRecords(path, format, fresh as Row[], columns);
    saveSeen(stateDir, spec.name, { rows: diff.next, updatedAt: at });
    return { path, format, mode, written: fresh.length, changes: diff.counts };
  }

  // changes
  if (format === "json") {
    throw new SinkError(
      'mode "changes" is a log, so it cannot use format "json" — use jsonl or csv',
    );
  }
  const changeColumns = ["_change", "_at", ...columns];
  appendRecords(path, format, diff.events as unknown as Row[], changeColumns);
  saveSeen(stateDir, spec.name, { rows: diff.next, updatedAt: at });
  return { path, format, mode, written: diff.events.length, changes: diff.counts };
}

function appendRecords(path: string, format: OutputFormat, rows: Row[], columns: string[]): void {
  if (rows.length === 0) return;
  if (format === "csv") {
    const needsHeader = !existsSync(path) || readFileSync(path, "utf8").trim() === "";
    const body = toCsv(rows, columns);
    appendFileSync(path, needsHeader ? body : body.slice(body.indexOf("\n") + 1));
    return;
  }
  if (format === "json") {
    throw new SinkError('format "json" cannot be appended to — use jsonl');
  }
  appendFileSync(path, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

export function validateOutput(raw: unknown, source: string): OutputConfig {
  if (!raw || typeof raw !== "object") throw new SinkError(`${source}: "output" must be an object`);
  const o = raw as Record<string, unknown>;
  if (typeof o["path"] !== "string" || !o["path"]) {
    throw new SinkError(`${source}: "output.path" is required`);
  }
  const format = o["format"];
  if (format !== undefined && !["jsonl", "json", "csv"].includes(format as string)) {
    throw new SinkError(`${source}: "output.format" must be jsonl, json or csv`);
  }
  const mode = o["mode"];
  if (mode !== undefined && !["snapshot", "append", "changes"].includes(mode as string)) {
    throw new SinkError(`${source}: "output.mode" must be snapshot, append or changes`);
  }
  if (mode === "changes" && format === "json") {
    throw new SinkError(`${source}: mode "changes" is a log; use jsonl or csv`);
  }
  const key = o["key"];
  if (
    key !== undefined &&
    typeof key !== "string" &&
    !(Array.isArray(key) && key.every((k) => typeof k === "string"))
  ) {
    throw new SinkError(`${source}: "output.key" must be a field name or a list of them`);
  }
  return o as unknown as OutputConfig;
}
