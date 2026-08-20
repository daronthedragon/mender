#!/usr/bin/env node
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { ConfigError, loadSpec, loadSpecs, patchSpecFile } from "./config.js";
import { runCheck, runRepair } from "./repair.js";
import { prBody, prTitle, renderCheck, renderRepair } from "./report.js";
import { saveFixture, todayStamp } from "./fixtures.js";
import { dim, green, red, yellow } from "./color.js";

const USAGE = `mender — scrapers that repair themselves

usage:
  mender check   [path]            run every scraper (or one spec file) against its contract
  mender extract <spec>            print the rows a spec currently produces, as JSON
  mender fixture <spec>            archive today's page as a golden snapshot (must pass first)
  mender repair  <spec>            diagnose, propose a fix, verify it, and show the diff

options:
  --scrapers <dir>   spec directory                       (default: scrapers)
  --fixtures <dir>   golden snapshot directory            (default: fixtures)
  --html <file>      use a local html file instead of fetching
  --write            repair: apply the verified fix to the spec file
  --pr-body <file>   repair: write a pull-request body to this path
  --json             machine-readable output
  --force            fixture: archive even if the contract does not pass
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

  if (!args.command || args.command === "help" || args.flags["help"]) {
    process.stdout.write(USAGE);
    return 0;
  }

  switch (args.command) {
    case "check": {
      const specs = specsFrom(args, scrapersDir);
      const results = [];
      for (const { spec } of specs) {
        results.push(await runCheck(spec, htmlFrom(args.flags)));
      }
      if (asJson) {
        process.stdout.write(
          JSON.stringify(
            results.map((r) => ({
              name: r.spec.name,
              cause: r.cause,
              detail: r.causeDetail,
              rows: r.rows.length,
              violations: r.violations,
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

    case "fixture": {
      const specs = specsFrom(args, scrapersDir);
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
        const outcome = await runRepair(spec, { fixturesRoot: fixturesDir, ...htmlFrom(args.flags) });
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
                  passes: f.passes,
                })),
                unresolved: outcome.unresolved,
                rejected: outcome.rejectedCount,
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
