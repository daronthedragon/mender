import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runCheck, runRepair } from "./repair.js";
import { loadSpec } from "./config.js";
import { bold, dim, green, red, yellow } from "./color.js";
import type { ScraperSpec } from "./types.js";

/**
 * The whole story, offline, in one command.
 *
 * A fresh clone has no scrapers, no fixtures and nothing to point at, so the
 * honest first five minutes were "read the README and hope". This runs the real
 * pipeline against the bundled example pages — no network, no config, no API
 * key — including the two cases where the right answer is to refuse.
 */

export class DemoError extends Error {}

/** Find the bundled examples whether running from source, dist, or node_modules. */
export function findExamples(from = fileURLToPath(import.meta.url)): string {
  let dir = dirname(from);
  for (let up = 0; up < 6; up++) {
    const candidate = join(dir, "examples");
    if (existsSync(join(candidate, "scrapers", "pricing.json"))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new DemoError(
    "the bundled examples are missing — run the demo from a clone, or reinstall the package",
  );
}

interface Scene {
  title: string;
  page: string;
  why: string;
  expect: "repair" | "refuse";
}

const SCENES: Scene[] = [
  {
    title: "A field moves to new markup",
    page: "v2-price-moved.html",
    why: "The price left .amount for a new element. This is the ordinary case.",
    expect: "repair",
  },
  {
    title: "The record container is renamed",
    page: "v3-rows-renamed.html",
    why: "Every row selector stops matching at once, so nothing extracts at all.",
    expect: "repair",
  },
  {
    title: "Records are regrouped, two to a wrapper",
    page: "v7-rows-regrouped.html",
    why: "The tempting selector grabs both records at once and silently halves the data.",
    expect: "repair",
  },
  {
    title: "The field is genuinely gone, and something else looks like it",
    page: "v4-price-gone-trap.html",
    why: "A star rating satisfies type:number, min:1. Accepting it would poison the data.",
    expect: "refuse",
  },
  {
    title: "The site is blocking us",
    page: "blocked.html",
    why: "Repairing here would teach the scraper to extract challenge text and call it green.",
    expect: "refuse",
  },
];

export interface DemoOptions {
  examplesDir?: string;
  write?: (s: string) => void;
}

export interface DemoResult {
  scenes: { title: string; expected: string; actual: string; ok: boolean }[];
  passed: number;
  failed: number;
}

export async function runDemo(opts: DemoOptions = {}): Promise<DemoResult> {
  const examples = opts.examplesDir ?? findExamples();
  const out = opts.write ?? ((s: string) => process.stdout.write(s));
  const spec: ScraperSpec = loadSpec(join(examples, "scrapers", "pricing.json"));
  const fixtures = join(examples, "fixtures");
  const page = (f: string) => readFileSync(join(examples, "pages", f), "utf8");

  out(bold("\nmender demo") + dim("  — the real pipeline, offline, against bundled pages\n"));
  out(dim(`  examples: ${resolve(examples)}\n`));

  const healthy = await runCheck(spec, { html: page("v1-original.html") });
  out(`\n${bold("0. The scraper as it was written")}\n`);
  out(dim("   " + JSON.stringify(healthy.rows) + "\n"));
  out(`   ${green(healthy.cause)} — ${healthy.rows.length} rows, contract satisfied\n`);

  const result: DemoResult = { scenes: [], passed: 0, failed: 0 };

  for (const [i, scene] of SCENES.entries()) {
    out(`\n${bold(`${i + 1}. ${scene.title}`)}\n`);
    out(dim(`   ${scene.why}\n`));

    const outcome = await runRepair(spec, { fixturesRoot: fixtures, html: page(scene.page) });
    const repaired = outcome.fixes.length > 0;
    const actual = repaired ? "repair" : "refuse";
    const ok = actual === scene.expect;

    out(dim(`   cause: ${outcome.check.cause}\n`));

    if (repaired) {
      for (const fix of outcome.fixes) {
        const target = fix.target === "__row__" ? "row" : fix.target;
        out(`   ${green("repaired")} ${target}\n`);
        out(`     ${red("- " + JSON.stringify(fix.target === "__row__" ? spec.row : spec.fields[fix.target]?.selector))}\n`);
        out(`     ${green("+ " + JSON.stringify(fix.selector))}\n`);
        for (const p of fix.passes) {
          out(dim(`       ${p.ok ? "ok" : "NO"} ${p.source.padEnd(11)} ${p.detail}\n`));
        }
      }
      const after = await runCheck(outcome.patched!, { html: page(scene.page) });
      out(dim("   " + JSON.stringify(after.rows) + "\n"));
    } else if (outcome.skippedReason) {
      out(`   ${yellow("refused")} — ${outcome.skippedReason}\n`);
    } else {
      out(`   ${yellow("refused")} — no candidate passed every gate\n`);
      for (const r of outcome.rejections.slice(0, 3)) {
        out(dim(`     tried ${r.selector.padEnd(22)} rejected at ${r.failedGate}: ${r.detail}\n`));
      }
    }

    out(ok ? dim("   (as expected)\n") : red(`   UNEXPECTED: wanted ${scene.expect}, got ${actual}\n`));
    result.scenes.push({ title: scene.title, expected: scene.expect, actual, ok });
    if (ok) result.passed++;
    else result.failed++;
  }

  out(
    `\n${result.failed === 0 ? green(`all ${result.passed} scenarios behaved as documented`) : red(`${result.failed} scenario(s) did not behave as documented`)}\n`,
  );
  out(dim("\n  next: mender init <url>   then   mender check\n\n"));
  return result;
}
