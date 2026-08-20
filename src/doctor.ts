import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadSpecs } from "./config.js";
import { extract } from "./extract.js";
import { validate } from "./contract.js";
import { listFixtures, loadFixtures, ageInDays } from "./fixtures.js";
import { loadHistory } from "./history.js";
import { notifiersFrom } from "./notify.js";
import { authHeaders } from "./fetch.js";
import { describeModel } from "./providers.js";
import type { MenderSettings } from "./settings.js";
import type { ScraperSpec } from "./types.js";

/**
 * Everything this tool can do depends on setup a user cannot see: whether a
 * fixture still passes, whether history is deep enough to judge drift, whether
 * the environment variable a spec names is actually exported. When it silently
 * does nothing, the reason is almost always in here.
 */

export type Severity = "ok" | "warn" | "error";

export interface Finding {
  severity: Severity;
  scope: string;
  message: string;
  fix?: string;
}

function fixtureFindings(spec: ScraperSpec, fixturesRoot: string, now: Date): Finding[] {
  const out: Finding[] = [];
  const loaded = loadFixtures(fixturesRoot, spec.name);

  if (loaded.length === 0) {
    out.push({
      severity: "error",
      scope: spec.name,
      message: "no fixtures — repair has nothing to verify against and will refuse to run",
      fix: `mender fixture scrapers/${spec.name}.json`,
    });
    return out;
  }

  const passing = loaded.filter((f) => validate(extract(f.doc, spec), spec).length === 0);
  const stale = loaded.length - passing.length;

  if (passing.length === 0) {
    out.push({
      severity: "error",
      scope: spec.name,
      message: `all ${loaded.length} fixture(s) fail the current spec, so there is no known-good reference`,
      fix: "archive a fresh one while the scraper works, then: mender fixture --prune",
    });
  } else {
    out.push({
      severity: "ok",
      scope: spec.name,
      message: `${passing.length} passing fixture(s)${stale > 0 ? `, ${stale} stale` : ""}`,
    });
    if (stale > 0) {
      out.push({
        severity: "warn",
        scope: spec.name,
        message: `${stale} fixture(s) no longer pass and are ignored`,
        fix: "mender fixture --prune",
      });
    }
  }

  const ages = listFixtures(fixturesRoot, spec.name)
    .map((f) => ageInDays(f.source, now))
    .filter((a): a is number => a !== null);
  const newest = ages.length > 0 ? Math.min(...ages) : null;
  if (newest !== null && newest > 180) {
    out.push({
      severity: "warn",
      scope: spec.name,
      message: `newest fixture is ${newest} days old, so a repair is judged against a very old page`,
      fix: "mender fixture <spec>",
    });
  }
  return out;
}

function historyFindings(spec: ScraperSpec, historyRoot: string, fixturesRoot: string): Finding[] {
  const runs = loadHistory(historyRoot, spec.name);
  const seeds = loadFixtures(fixturesRoot, spec.name).length;
  const total = runs.length + seeds;

  if (total >= 3) {
    return [{ severity: "ok", scope: spec.name, message: `drift baseline: ${runs.length} run(s) + ${seeds} fixture(s)` }];
  }
  return [
    {
      severity: "warn",
      scope: spec.name,
      message: `drift baseline is thin (${total} observation(s)); findings will be provisional`,
      fix: "run with --record so healthy runs build the baseline",
    },
  ];
}

function authFindings(spec: ScraperSpec, env: NodeJS.ProcessEnv): Finding[] {
  if (!spec.auth) return [];
  try {
    authHeaders(spec.auth, env);
    return [{ severity: "ok", scope: spec.name, message: "auth environment variables are all set" }];
  } catch (e) {
    return [
      {
        severity: "error",
        scope: spec.name,
        message: (e as Error).message,
        fix: "export the variable before running, or drop the auth block",
      },
    ];
  }
}

function renderFindings(specs: ScraperSpec[]): Finding[] {
  const needing = specs.filter((s) => s.render).map((s) => s.name);
  if (needing.length === 0) return [];
  const installed = existsSync(join("node_modules", "playwright", "package.json"));
  return [
    installed
      ? { severity: "ok", scope: "render", message: `playwright is installed for: ${needing.join(", ")}` }
      : {
          severity: "error",
          scope: "render",
          message: `${needing.join(", ")} ask for browser rendering but playwright is not installed`,
          fix: "npm install playwright && npx playwright install chromium",
        },
  ];
}

function notifyFindings(settings: MenderSettings, env: NodeJS.ProcessEnv): Finding[] {
  if (!settings.notify) {
    return [
      {
        severity: "warn",
        scope: "notify",
        message: "no notification channels configured, so a break in watch mode is only visible in the log",
        fix: 'add a "notify" block to mender.config.json',
      },
    ];
  }
  try {
    const built = notifiersFrom(settings.notify, env);
    return [
      built.length > 0
        ? { severity: "ok", scope: "notify", message: `channels: ${built.map((n) => n.name).join(", ")}` }
        : { severity: "warn", scope: "notify", message: "a notify block is present but enables no channels" },
    ];
  } catch (e) {
    return [
      {
        severity: "error",
        scope: "notify",
        message: (e as Error).message,
        fix: "export the webhook variable, or remove that channel",
      },
    ];
  }
}

function modelFindings(settings: MenderSettings, env: NodeJS.ProcessEnv): Finding[] {
  if (!settings.model) {
    return [
      {
        severity: "ok",
        scope: "model",
        message: "no model configured; heuristics repair on their own and cost nothing",
      },
    ];
  }
  const cfg = typeof settings.model === "object" ? settings.model : {};
  const seen = describeModel(cfg, env);
  if (!seen.provider) {
    return [
      {
        severity: "error",
        scope: "model",
        message: "a model is enabled but no provider could be determined",
        fix: "set ANTHROPIC_API_KEY, OPENAI_API_KEY or GEMINI_API_KEY, or pin one with \"provider\"",
      },
    ];
  }
  if (!seen.hasKey) {
    return [
      {
        severity: "error",
        scope: "model",
        message: `${seen.provider} is configured but ${seen.keyVar ?? "its API key"} is not set`,
        fix: `export ${seen.keyVar ?? "the API key"}, or switch to a local provider with "provider": "ollama"`,
      },
    ];
  }
  return [
    { severity: "ok", scope: "model", message: `${seen.provider} / ${seen.model}, key present` },
  ];
}

export interface DoctorOptions {
  scrapersDir: string;
  fixturesRoot: string;
  historyRoot: string;
  settings: MenderSettings;
  env?: NodeJS.ProcessEnv;
  now?: Date;
}

export interface DoctorReport {
  findings: Finding[];
  errors: number;
  warnings: number;
}

/** Static checks only — nothing here touches the network. */
export function doctor(opts: DoctorOptions): DoctorReport {
  const env = opts.env ?? process.env;
  const now = opts.now ?? new Date();
  const findings: Finding[] = [];

  let specs: { spec: ScraperSpec }[] = [];
  try {
    specs = loadSpecs(opts.scrapersDir);
    findings.push({
      severity: "ok",
      scope: "specs",
      message: `${specs.length} spec(s) in ${opts.scrapersDir}, all valid`,
    });
  } catch (e) {
    findings.push({
      severity: "error",
      scope: "specs",
      message: (e as Error).message,
      fix: "mender init <url>",
    });
    return { findings, errors: 1, warnings: 0 };
  }

  const list = specs.map((s) => s.spec);
  for (const spec of list) {
    findings.push(...fixtureFindings(spec, opts.fixturesRoot, now));
    findings.push(...historyFindings(spec, opts.historyRoot, opts.fixturesRoot));
    findings.push(...authFindings(spec, env));
  }
  findings.push(...renderFindings(list));
  findings.push(...notifyFindings(opts.settings, env));
  findings.push(...modelFindings(opts.settings, env));

  if (opts.settings.heal === undefined || opts.settings.heal === false) {
    findings.push({
      severity: "warn",
      scope: "heal",
      message: "healing is off, so a break is reported but never repaired",
      fix: 'set "heal": "write" in mender.config.json, or pass --heal',
    });
  }

  return {
    findings,
    errors: findings.filter((f) => f.severity === "error").length,
    warnings: findings.filter((f) => f.severity === "warn").length,
  };
}
