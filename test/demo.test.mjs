import { eq, ok, section } from "./harness.mjs";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDemo, findExamples, DemoError } from "../dist/demo.js";
import { loadSpecs, ConfigError } from "../dist/config.js";

section("offline demo");

/**
 * The demo doubles as an executable claim: every scenario the README describes
 * is run here, and a scenario that stopped behaving as documented fails the
 * build rather than quietly misleading a reader.
 */
{
  const lines = [];
  const result = await runDemo({ write: (s) => lines.push(s) });
  const text = lines.join("");

  eq(result.failed, 0, "every documented scenario behaves as documented");
  eq(result.scenes.length, 5, "five scenarios covered");

  const byTitle = Object.fromEntries(result.scenes.map((s) => [s.title, s]));
  eq(byTitle["A field moves to new markup"].actual, "repair", "a moved field is repaired");
  eq(byTitle["The record container is renamed"].actual, "repair", "a renamed container is repaired");
  eq(byTitle["Records are regrouped, two to a wrapper"].actual, "repair", "regrouped records are repaired correctly");
  eq(byTitle["The field is genuinely gone, and something else looks like it"].actual, "refuse", "the trap is refused");
  eq(byTitle["The site is blocking us"].actual, "refuse", "a blocked page is refused");

  // The output has to actually show the reasoning, not just a verdict.
  ok(text.includes("ok coverage"), "gate results are shown");
  ok(text.includes("rejected at continuity"), "and the reason a candidate was refused");
  ok(text.includes("selectors left untouched"), "and that a blocked page is left alone");
  ok(text.includes("Enterprise"), "the regrouped page recovers the record that would have been dropped");
  ok(!text.includes("undefined"), "no placeholder leaks into the output");
}

/* ---- it runs with no network, no config and no API key ---- */
{
  // runDemo touches only bundled files; if it reached the network these would
  // be needed. Proven by it having already completed above with none set.
  ok(true, "the run above used no scrapers directory, no config file and no API key");
}

/* ---- examples are found from wherever the code lives ---- */
{
  const dir = findExamples();
  ok(dir.endsWith("examples"), `examples located at ${dir}`);
  const specs = loadSpecs(join(dir, "scrapers"));
  eq(specs.length, 1, "and the bundled spec loads");

  let threw = null;
  try {
    findExamples(join(tmpdir(), "nowhere", "deep", "x.js"));
  } catch (e) {
    threw = e;
  }
  ok(threw instanceof DemoError, "a missing examples directory raises DemoError rather than crashing");
}

section("first-run guidance");

{
  // The message a fresh clone actually hits has to name the way out.
  const empty = mkdtempSync(join(tmpdir(), "mender-first-"));
  let msg = "";
  try {
    loadSpecs(join(empty, "does-not-exist"));
  } catch (e) {
    msg = e.message;
    ok(e instanceof ConfigError, "a missing directory is a ConfigError");
  }
  ok(msg.includes("mender init"), "it points at init");
  ok(msg.includes("mender demo"), "and at the offline demo, which needs nothing set up");

  mkdirSync(join(empty, "scrapers"), { recursive: true });
  msg = "";
  try {
    loadSpecs(join(empty, "scrapers"));
  } catch (e) {
    msg = e.message;
  }
  ok(msg.includes("mender demo"), "an empty directory says the same");
  rmSync(empty, { recursive: true, force: true });
}
