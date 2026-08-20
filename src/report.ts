import { ROW_TARGET } from "./propose.js";
import { bold, dim, green, red, yellow } from "./color.js";
import type { CheckResult, Cause } from "./types.js";
import type { RepairOutcome } from "./repair.js";

const CAUSE_COLOR: Record<Cause, (s: string) => string> = {
  OK: green,
  LAYOUT_CHANGE: yellow,
  BLOCKED: red,
  HTTP_ERROR: red,
  REDIRECTED: red,
  EMPTY: red,
};

export function renderCheck(result: CheckResult): string {
  const { spec, cause, causeDetail, violations, rows } = result;
  const paint = CAUSE_COLOR[cause];
  const lines: string[] = [];

  lines.push(`${bold(spec.name)}  ${paint(cause)}  ${dim(causeDetail)}`);
  lines.push(dim(`  ${spec.url}  ${result.fetched.status} · ${result.fetched.ms}ms · ${rows.length} rows`));

  const shown = violations.slice(0, 6);
  for (const v of shown) {
    const where = v.field ? `${v.field}${v.row !== undefined ? `[row ${v.row}]` : ""}` : "rows";
    lines.push(`  ${red("x")} ${where}: ${v.detail}`);
  }
  if (violations.length > shown.length) {
    lines.push(dim(`  … and ${violations.length - shown.length} more violations`));
  }
  return lines.join("\n");
}

function label(target: string): string {
  return target === ROW_TARGET ? "row" : target;
}

export function renderRepair(outcome: RepairOutcome, specPath: string): string {
  const lines: string[] = [renderCheck(outcome.check)];

  if (outcome.staleFixtures.length > 0) {
    lines.push(
      yellow(
        `  ! ${outcome.staleFixtures.length} fixture(s) no longer pass the current spec and were not used: ${outcome.staleFixtures.join(", ")}`,
      ),
    );
  }

  if (outcome.skippedReason) {
    lines.push(`  ${dim("no repair attempted:")} ${outcome.skippedReason}`);
    return lines.join("\n");
  }

  for (const fix of outcome.fixes) {
    const old =
      fix.target === ROW_TARGET
        ? outcome.check.spec.row
        : outcome.check.spec.fields[fix.target]?.selector;
    lines.push(`  ${green("fixed")} ${bold(label(fix.target))} ${dim(`via ${fix.via ?? "heuristic"}`)}`);
    lines.push(`    ${red("- " + JSON.stringify(old))}`);
    lines.push(`    ${green("+ " + JSON.stringify(fix.selector))}`);
    for (const p of fix.passes) {
      lines.push(`      ${p.ok ? green("ok") : red("no")} ${p.source.padEnd(12)} ${dim(p.detail)}`);
    }
  }

  for (const t of outcome.unresolved) {
    lines.push(`  ${red("unfixed")} ${bold(label(t))} ${dim("no candidate passed every gate")}`);
    for (const r of outcome.rejections.filter((x) => x.target === t)) {
      lines.push(
        `    ${dim("tried")} ${r.selector.padEnd(24)} ${dim("(" + r.via + ")")} ${red("rejected at " + r.failedGate)} ${dim(r.detail)}`,
      );
    }
  }

  if (outcome.rejectedCount > 0) {
    lines.push(
      dim(
        `  ${outcome.rejectedCount} candidate(s) rejected by verification` +
          (outcome.modelUsed ? `, model consulted: ${outcome.modelUsed}` : ""),
      ),
    );
  }
  if (outcome.patched) {
    lines.push(dim(`  spec: ${specPath}`));
  }
  return lines.join("\n");
}

export function prTitle(outcome: RepairOutcome): string {
  const name = outcome.check.spec.name;
  const targets = outcome.fixes.map((f) => label(f.target));
  if (targets.length === 1) {
    const fix = outcome.fixes[0]!;
    const old =
      fix.target === ROW_TARGET
        ? outcome.check.spec.row
        : outcome.check.spec.fields[fix.target]?.selector;
    return `fix(${name}): ${targets[0]} selector ${old} -> ${fix.selector}`;
  }
  return `fix(${name}): repair ${targets.length} selectors (${targets.join(", ")})`;
}

export function prBody(outcome: RepairOutcome, specPath: string, stamp: string): string {
  const { check } = outcome;
  const out: string[] = [];

  out.push(`**Detected:** ${stamp}`);
  out.push(`**Cause:** ${check.cause} — ${check.causeDetail}`);
  out.push(
    `**Symptom:** ${check.violations.length} contract violation${check.violations.length === 1 ? "" : "s"}` +
      (check.violations[0] ? ` (first: ${check.violations[0].detail})` : ""),
  );
  out.push("");
  out.push("```diff");
  for (const fix of outcome.fixes) {
    const old =
      fix.target === ROW_TARGET
        ? outcome.check.spec.row
        : outcome.check.spec.fields[fix.target]?.selector;
    out.push(`  ${label(fix.target)}:`);
    out.push(`- ${JSON.stringify(old)}`);
    out.push(`+ ${JSON.stringify(fix.selector)}`);
  }
  out.push("```");
  out.push("");
  if (outcome.modelUsed) {
    out.push(`**Proposed by:** ${outcome.fixes.map((f) => f.via ?? "heuristic").join(", ")}`);
    out.push("");
  }
  out.push("**Verification**");
  out.push("");
  out.push("| target | page | result |");
  out.push("| --- | --- | --- |");
  for (const fix of outcome.fixes) {
    for (const p of fix.passes) {
      out.push(`| \`${label(fix.target)}\` | ${p.source} | ${p.ok ? "pass" : "FAIL"} — ${p.detail} |`);
    }
  }
  out.push("");
  if (outcome.unresolved.length > 0) {
    out.push(
      `> Still broken and left for a human: ${outcome.unresolved.map((t) => `\`${label(t)}\``).join(", ")}`,
    );
    out.push("");
  }
  out.push(
    `${outcome.rejectedCount} candidate selector(s) were rejected because they failed on the live page or regressed an archived snapshot.`,
  );
  out.push("");
  out.push(`Spec: \`${specPath}\``);
  return out.join("\n");
}
