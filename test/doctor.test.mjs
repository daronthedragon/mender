import { eq, ok, section } from "./harness.mjs";
import { mkdtempSync, rmSync, copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { doctor } from "../dist/doctor.js";

section("doctor");

const find = (report, scope, severity) =>
  report.findings.find((f) => f.scope === scope && (!severity || f.severity === severity));

function project({ withFixture = true, staleFixture = false, spec = "examples/scrapers/pricing.json" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "mender-doctor-"));
  mkdirSync(join(dir, "scrapers"), { recursive: true });
  mkdirSync(join(dir, "fixtures", "pricing"), { recursive: true });
  copyFileSync(spec, join(dir, "scrapers", "pricing.json"));
  if (withFixture) {
    copyFileSync("examples/pages/v1-original.html", join(dir, "fixtures", "pricing", "2026-07-02.html"));
  }
  if (staleFixture) {
    copyFileSync("examples/pages/v3-rows-renamed.html", join(dir, "fixtures", "pricing", "2024-01-01.html"));
  }
  return dir;
}

const run = (dir, settings = {}, env = {}) =>
  doctor({
    scrapersDir: join(dir, "scrapers"),
    fixturesRoot: join(dir, "fixtures"),
    historyRoot: join(dir, "fixtures"),
    settings,
    env,
    now: new Date("2026-08-20T00:00:00Z"),
  });

/* ---- a healthy-enough project ---- */
{
  const dir = project();
  const r = run(dir, { heal: "write", notify: { console: true } });
  eq(r.errors, 0, "a set-up project has no blocking problems");
  ok(find(r, "specs", "ok"), "specs are reported valid");
  ok(find(r, "pricing", "ok").message.includes("passing fixture"), "and the fixture is counted");
  rmSync(dir, { recursive: true, force: true });
}

/* ---- the failure that silently disables repair ---- */
{
  const dir = project({ withFixture: false });
  const r = run(dir, { heal: "write" });
  const f = find(r, "pricing", "error");
  ok(f, "no fixtures is an error, not a warning");
  ok(f.message.includes("repair has nothing to verify against"), "and says what it costs you");
  ok(f.fix.includes("mender fixture"), "with the command that fixes it");
  rmSync(dir, { recursive: true, force: true });
}

{
  const dir = project({ withFixture: false, staleFixture: true });
  const r = run(dir, { heal: "write" });
  const f = find(r, "pricing", "error");
  ok(f.message.includes("no known-good reference"), "all-stale fixtures is also an error");
  ok(f.fix.includes("prune"), "and points at prune");
  rmSync(dir, { recursive: true, force: true });
}

{
  const dir = project({ staleFixture: true });
  const r = run(dir, { heal: "write" });
  eq(r.errors, 0, "one passing fixture beside a stale one is fine");
  ok(
    r.findings.some((f) => f.scope === "pricing" && f.severity === "warn" && f.message.includes("no longer pass")),
    "but the stale one is still flagged",
  );
  rmSync(dir, { recursive: true, force: true });
}

/* ---- configuration that would silently do nothing ---- */
{
  const dir = project();
  const r = run(dir, {});
  ok(find(r, "heal", "warn"), "healing being off is worth saying out loud");
  ok(find(r, "notify", "warn"), "so is having no notification channels");
  rmSync(dir, { recursive: true, force: true });
}

{
  const dir = project();
  const r = run(dir, { heal: true, notify: { slack: { webhookEnv: "ABSENT_HOOK" } } }, {});
  const f = find(r, "notify", "error");
  ok(f, "a notify channel whose variable is unset is an error");
  ok(f.message.includes("ABSENT_HOOK"), "naming the variable");

  const good = run(dir, { heal: true, notify: { slack: { webhookEnv: "HOOK" } } }, { HOOK: "https://x" });
  ok(find(good, "notify", "ok"), "and resolves once it is exported");
  rmSync(dir, { recursive: true, force: true });
}

/* ---- auth ---- */
{
  const dir = project();
  const specPath = join(dir, "scrapers", "pricing.json");
  const { readFileSync } = await import("node:fs");
  const raw = JSON.parse(readFileSync(specPath, "utf8"));
  raw.auth = { headerEnv: { Authorization: "NEEDED_TOKEN" } };
  writeFileSync(specPath, JSON.stringify(raw, null, 2));

  const missing = run(dir, { heal: true }, {});
  ok(
    missing.findings.some((f) => f.severity === "error" && f.message.includes("NEEDED_TOKEN")),
    "an unset auth variable is an error naming it",
  );
  const present = run(dir, { heal: true }, { NEEDED_TOKEN: "abc" });
  ok(
    present.findings.some((f) => f.scope === "pricing" && f.message.includes("auth environment variables")),
    "and passes once exported",
  );
  rmSync(dir, { recursive: true, force: true });
}

/* ---- an empty project explains itself ---- */
{
  const dir = mkdtempSync(join(tmpdir(), "mender-empty-doc-"));
  mkdirSync(join(dir, "scrapers"), { recursive: true });
  const r = run(dir, {});
  eq(r.errors, 1, "an empty project reports one blocking problem");
  ok(r.findings[0].fix.includes("mender init"), "and tells you how to start");
  rmSync(dir, { recursive: true, force: true });
}
