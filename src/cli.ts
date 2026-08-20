#!/usr/bin/env node
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { ConfigError, loadSpec, loadSpecs, patchSpecFile } from "./config.js";
import { runCheck, runRepair } from "./repair.js";
import { prBody, prTitle, renderCheck, renderRepair } from "./report.js";
import { listFixtures, loadFixtures, retire, retirementPlan, saveFixture, todayStamp } from "./fixtures.js";
import { anthropicClient } from "./llm.js";
import { extract } from "./extract.js";
import { validate } from "./contract.js";
import { pruneHistory } from "./history.js";
import { dim, green, red, yellow } from "./color.js";

const USAGE = `mender — scrapers that repair themselves

usage:
  mender check   [path]            run every scraper (or one spec file) against its contract
  mender extract <spec>            print the rows a spec currently produces, as JSON
  mender fixture <spec>            archive today's page as a golden snapshot (must pass first)
  mender repair  <spec>            diagnose, propose a fix, verify it, and show the diff
  mender drift   [path]            report meaning-level drift against run history

options:
  --scrapers <dir>   spec directory                       (default: scrapers)
  --fixtures <dir>   golden snapshot directory            (default: fixtures)
  --html <file>      use a local html file instead of fetching
  --write            repair: apply the verified fix to the spec file
  --pr-body <file>   repair: write a pull-request body to this path
  --json             machine-readable output
  --force            fixture: archive even if the contract does not pass
  --model            repair: ask a model when the heuristics come up empty
                     (needs ANTHROPIC_API_KEY; proposals face the same gates)
  --record           check/drift: append this run to the history file
  --prune            fixture: retire snapshots that have stopped being useful
  --max-age-days <n> fixture --prune: retire failing snapshots older than this (default 180)
  --keep <n>         fixture --prune: keep at most this many snapshots (default 10)
`;

interface Args {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): Args {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const name = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[name] = next;
        i++;
      } else {
        flags[name] = true;
      }
    } else {
      positional.push(a);
    }
  }
  return { command: positional[0] ?? "", positional: positional.slice(1), flags };
}

function str(flags: Args["flags"], key: string, fallback: string): string {
  const v = flags[key];
  return typeof v === "string" ? v : fallback;
}

function num(flags: Args["flags"], key: string): number | null {
  const v = flags[key];
  if (typeof v !== "string") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function htmlFrom(flags: Args["flags"]): { html?: string } {
  const path = flags["html"];
  if (typeof path !== "string") return {};
  return { html: readFileSync(path, "utf8") };
}

function specsFrom(args: Args, scrapersDir: string): { path: string; spec: ReturnType<typeof loadSpec> }[] {
  const target = args.positional[0];
  if (!target) return loadSpecs(scrapersDir);
  const st = statSync(target, { throwIfNoEntry: false });
  if (st?.isDirectory()) return loadSpecs(target);
  return [{ path: target, spec: loadSpec(target) }];
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const scrapersDir = str(args.flags, "scrapers", "scrapers");
  const fixturesDir = str(args.flags, "fixtures", "fixtures");
  const asJson = args.flags["json"] === true;
  const historyRoot = str(args.flags, "history", fixturesDir);
  const wantModel = args.flags["model"] === true;

  const model = wantModel ? anthropicClient() : null;
  if (wantModel && !model) {
    process.stderr.write(
      yellow("--model requested but ANTHROPIC_API_KEY is not set; continuing with heuristics only\n"),
    );
  }

  if (!args.command || args.command === "help" || args.flags["help"]) {
    process.stdout.write(USAGE);
    return 0;
  }

  switch (args.command) {
    case "check": {
      const specs = specsFrom(args, scrapersDir);
      const results = [];
      for (const { spec } of specs) {
        results.push(
          await runCheck(spec, {
            ...htmlFrom(args.flags),
            historyRoot,
            record: args.flags["record"] === true,
          }),
        );
      }
      if (asJson) {
        process.stdout.write(
          JSON.stringify(
            results.map((r) => ({
              name: r.spec.name,
              cause: r.cause,
              detail: r.causeDetail,
              rows: r.rows.length,
              pages: r.pages.length,
              violations: r.violations,
              drift: r.drift,
            })),
            null,
            2,
          ) + "\n",
        );
      } else {
        for (const r of results) process.stdout.write(renderCheck(r) + "\n\n");
        const broken = results.filter((r) => r.cause !== "OK").length;
        process.stdout.write(
          broken === 0
            ? green(`${results.length} scraper(s) healthy\n`)
            : yellow(`${broken}/${results.length} scraper(s) failing\n`),
        );
      }
      return results.some((r) => r.cause !== "OK") ? 1 : 0;
    }

    case "extract": {
      const specs = specsFrom(args, scrapersDir);
      const spec = specs[0]?.spec;
      if (!spec) throw new ConfigError("no spec to extract");
      const opts = htmlFrom(args.flags);
      const result = await runCheck(spec, opts);
      process.stdout.write(JSON.stringify(result.rows, null, 2) + "\n");
      return result.violations.length === 0 ? 0 : 1;
    }

    case "drift": {
      const specs = specsFrom(args, scrapersDir);
      let found = 0;
      for (const { spec } of specs) {
        const result = await runCheck(spec, {
          ...htmlFrom(args.flags),
          historyRoot,
          record: args.flags["record"] === true,
          ...(num(args.flags, "median-shift") !== null || num(args.flags, "row-shift") !== null
            ? {
                drift: {
                  ...(num(args.flags, "median-shift") !== null
                    ? { medianShift: num(args.flags, "median-shift")! }
                    : {}),
                  ...(num(args.flags, "row-shift") !== null
                    ? { rowShift: num(args.flags, "row-shift")! }
                    : {}),
                },
              }
            : {}),
        });
        found += result.drift.length;
        if (asJson) {
          process.stdout.write(JSON.stringify({ name: spec.name, drift: result.drift }, null, 2) + "\n");
          continue;
        }
        if (result.cause !== "OK") {
          process.stdout.write(
            yellow(`${spec.name}: ${result.cause} — drift is only judged on a structurally sound run\n`),
          );
          continue;
        }
        if (result.drift.length === 0) {
          process.stdout.write(green(`${spec.name}: no drift against history\n`));
          continue;
        }
        process.stdout.write(yellow(`${spec.name}: ${result.drift.length} drift finding(s)\n`));
        for (const d of result.drift) {
          const where = d.field === "__rows__" ? "rows" : d.field;
          process.stdout.write(`  ~ ${where}: ${d.detail} ${dim(`(${d.code})`)}\n`);
        }
      }
      // Drift is a warning for a human, never a trigger for a selector repair.
      return found > 0 ? 1 : 0;
    }

    case "fixture": {
      const specs = specsFrom(args, scrapersDir);

      if (args.flags["prune"] === true) {
        let removed = 0;
        for (const { spec } of specs) {
          const loaded = loadFixtures(fixturesDir, spec.name);
          const passing = new Set(
            loaded.filter((f) => validate(extract(f.doc, spec), spec).length === 0).map((f) => f.source),
          );
          const plan = retirementPlan(
            listFixtures(fixturesDir, spec.name),
            (source) => passing.has(source),
            {
              maxAgeDays: num(args.flags, "max-age-days") ?? 180,
              keep: num(args.flags, "keep") ?? 10,
            },
          );
          for (const r of plan) {
            process.stdout.write(yellow(`${spec.name}: retiring ${r.source} — ${r.reason}\n`));
          }
          removed += retire(plan);
          const droppedRuns = pruneHistory(historyRoot, spec.name, num(args.flags, "keep-history") ?? 200);
          if (droppedRuns > 0) {
            process.stdout.write(dim(`${spec.name}: trimmed ${droppedRuns} old history record(s)\n`));
          }
          if (plan.length === 0) {
            process.stdout.write(green(`${spec.name}: nothing to retire\n`));
          }
        }
        return removed > 0 ? 0 : 1;
      }

      let saved = 0;
      for (const { spec } of specs) {
        const opts = htmlFrom(args.flags);
        const result = await runCheck(spec, opts);
        if (result.cause !== "OK" && args.flags["force"] !== true) {
          process.stdout.write(
            red(`${spec.name}: not archiving — ${result.cause} (${result.causeDetail})\n`) +
              dim("  a fixture is only useful as a known-good reference; pass --force to override\n"),
          );
          continue;
        }
        const path = saveFixture(fixturesDir, spec.name, result.fetched.html, todayStamp());
        process.stdout.write(green(`${spec.name}: archived ${path} (${result.rows.length} rows)\n`));
        saved++;
      }
      return saved > 0 ? 0 : 1;
    }

    case "repair": {
      const specs = specsFrom(args, scrapersDir);
      let anyFixed = false;
      for (const { path, spec } of specs) {
        const outcome = await runRepair(spec, {
          fixturesRoot: fixturesDir,
          historyRoot,
          model,
          ...htmlFrom(args.flags),
        });
        if (asJson) {
          process.stdout.write(
            JSON.stringify(
              {
                name: spec.name,
                cause: outcome.check.cause,
                attempted: outcome.attempted,
                skipped: outcome.skippedReason,
                fixes: outcome.fixes.map((f) => ({
                  target: f.target,
                  selector: f.selector,
                  via: f.via ?? "heuristic",
                  passes: f.passes,
                })),
                unresolved: outcome.unresolved,
                rejected: outcome.rejectedCount,
                rejections: outcome.rejections,
                modelUsed: outcome.modelUsed,
              },
              null,
              2,
            ) + "\n",
          );
        } else {
          process.stdout.write(renderRepair(outcome, path) + "\n\n");
        }

        if (outcome.fixes.length > 0) {
          anyFixed = true;
          if (args.flags["write"] === true) {
            for (const fix of outcome.fixes) patchSpecFile(path, fix.target, fix.selector);
            process.stdout.write(green(`wrote ${outcome.fixes.length} selector(s) to ${path}\n`));
          }
          const bodyPath = args.flags["pr-body"];
          if (typeof bodyPath === "string") {
            const stamp = new Date().toISOString().replace("T", " ").slice(0, 16) + " UTC";
            writeFileSync(bodyPath, `# ${prTitle(outcome)}\n\n${prBody(outcome, path, stamp)}\n`);
            process.stdout.write(dim(`pr body written to ${bodyPath}\n`));
          }
        }
      }
      return anyFixed ? 0 : 1;
    }

    default:
      process.stderr.write(red(`unknown command "${args.command}"\n\n`) + USAGE);
      return 2;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((e: unknown) => {
    const err = e as Error;
    process.stderr.write(red(`${err.name}: ${err.message}\n`));
    process.exit(2);
  });
