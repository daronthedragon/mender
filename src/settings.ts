import { existsSync, readFileSync } from "node:fs";
import type { NotifyConfig } from "./notify.js";
import type { DriftOptions } from "./history.js";
import type { ModelConfig } from "./providers.js";
import type { PolitenessConfig } from "./politeness.js";
import type { OutputConfig } from "./sink.js";

/**
 * Project-level settings, so a deployment is a committed file plus environment
 * variables rather than a shell script full of flags.
 */
export interface MenderSettings {
  scrapers?: string;
  fixtures?: string;
  history?: string;
  /** Repair automatically. "write" persists repaired selectors to the spec. */
  heal?: boolean | "write";
  /**
   * Consult a model when the heuristics come up empty. `true` infers the
   * provider from whichever API key is in the environment; an object pins it.
   */
  model?: boolean | ModelConfig;
  /** Seconds between cycles in watch mode. */
  interval?: number;
  /** How many scrapers to run at once. */
  concurrency?: number;
  /** Record each healthy run into history, building the drift baseline. */
  record?: boolean;
  drift?: DriftOptions;
  /** robots.txt and per-host rate limiting. On by default. */
  politeness?: PolitenessConfig;
  /** Default destination for every scraper's rows. A spec may override it. */
  output?: OutputConfig;
  notify?: NotifyConfig;
}

export const DEFAULT_SETTINGS: Required<
  Pick<MenderSettings, "scrapers" | "fixtures" | "interval" | "concurrency">
> = {
  scrapers: "scrapers",
  fixtures: "fixtures",
  interval: 900,
  concurrency: 4,
};

export const SETTINGS_FILES = ["mender.config.json", ".menderrc.json"];

export class SettingsError extends Error {}

export function loadSettings(path?: string): MenderSettings {
  const file = path ?? SETTINGS_FILES.find((f) => existsSync(f));
  if (!file) return {};
  if (!existsSync(file)) {
    throw new SettingsError(`no settings file at ${file}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new SettingsError(`${file}: ${(e as Error).message}`);
  }
  if (!raw || typeof raw !== "object") {
    throw new SettingsError(`${file}: expected an object`);
  }
  const s = raw as MenderSettings;

  if (s.interval !== undefined && (typeof s.interval !== "number" || s.interval < 5)) {
    throw new SettingsError(`${file}: "interval" must be a number of seconds, at least 5`);
  }
  if (s.concurrency !== undefined && (typeof s.concurrency !== "number" || s.concurrency < 1)) {
    throw new SettingsError(`${file}: "concurrency" must be a positive number`);
  }
  if (s.heal !== undefined && s.heal !== true && s.heal !== false && s.heal !== "write") {
    throw new SettingsError(`${file}: "heal" must be true, false or "write"`);
  }
  return s;
}

/** Human durations in a config file beat a raw seconds count. "15m" -> 900. */
export function parseDuration(input: string | number): number {
  if (typeof input === "number") return input;
  const m = /^(\d+(?:\.\d+)?)\s*(s|m|h|d)?$/i.exec(input.trim());
  if (!m) throw new SettingsError(`cannot read "${input}" as a duration (try 30s, 15m, 2h)`);
  const value = Number(m[1]);
  const unit = (m[2] ?? "s").toLowerCase();
  const scale = unit === "s" ? 1 : unit === "m" ? 60 : unit === "h" ? 3600 : 86400;
  return Math.round(value * scale);
}

export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${(seconds / 3600).toFixed(1).replace(/\.0$/, "")}h`;
  return `${(seconds / 86400).toFixed(1).replace(/\.0$/, "")}d`;
}
