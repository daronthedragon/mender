import { eq, ok, section } from "./harness.mjs";
import { readFileSync, mkdtempSync, rmSync, copyFileSync, mkdirSync, readFileSync as read } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scrape, scrapeAll, rows, defineSpec, MenderError, resolveSpec } from "../dist/api.js";
import { ConfigError } from "../dist/config.js";

section("public api");

const page = (f) => readFileSync(`examples/pages/${f}`, "utf8");

const SPEC = defineSpec({
  name: "pricing",
  url: "https://example.com/pricing",
  row: ".pricing-card",
  fields: {
    plan: { selector: ".plan-title", type: "string" },
    price: { selector: ".amount", type: "number", min: 1 },
  },
  expect: { rows: { min: 2, max: 8 } },
});

const opts = (extra = {}) => ({ fixtures: "examples/fixtures", ...extra });

/* ---- the happy path ---- */
{
  const r = await scrape(SPEC, opts({ html: page("v1-original.html") }));
  eq(r.ok, true, "a healthy scraper reports ok");
  eq(r.cause, "OK", "with cause OK");
  eq(r.rows.length, 3, "and returns its rows");
  eq(r.rows[0].price, 19, "with parsed values");
  eq(r.healed.length, 0, "nothing was healed");
  eq(r.pages, 1, "one page fetched");
}

/* ---- broken, healing off: report, do not invent ---- */
{
  const r = await scrape(SPEC, opts({ html: page("v2-price-moved.html") }));
  eq(r.ok, false, "a broken scraper reports not-ok");
  eq(r.cause, "LAYOUT_CHANGE", "with the diagnosed cause");
  eq(r.rows[0].price, null, "and returns the real (missing) value rather than guessing");
  eq(r.healed.length, 0, "healing is off by default");
  ok(r.violations.length > 0, "violations are exposed to the caller");
}

/* ---- broken, healing on: real data, in memory ---- */
{
  const events = [];
  const r = await scrape(
    SPEC,
    opts({ html: page("v2-price-moved.html"), heal: true, onEvent: (e) => events.push(e) }),
  );
  eq(r.ok, true, "healing recovers the run");
  eq(r.rows.map((x) => x.price).join(","), "21,54,219", "and returns the real repaired data");
  eq(r.healed.length, 1, "one selector healed");
  eq(r.healed[0].target, "price", "the broken field");
  eq(r.healed[0].from, ".amount", "recording what it was");
  eq(r.healed[0].to, '.amount, [data-testid="price-value"]', "and what it became");
  eq(r.healed[0].via, "heuristic", "and which proposer found it");
  eq(events.map((e) => e.type).join(">"), "checked>healing>healed", "events describe the run");

  // Healing in memory must not touch the caller's spec object.
  eq(SPEC.fields.price.selector, ".amount", "the caller's spec object is not mutated");
}

/* ---- healing cannot rescue what cannot be verified ---- */
{
  const r = await scrape(SPEC, opts({ html: page("v4-price-gone-trap.html"), heal: true }));
  eq(r.ok, false, "an unverifiable repair leaves the run failing");
  eq(r.healed.length, 0, "nothing was healed");
  eq(r.unhealed.join(), "price", "and the caller is told which target is still broken");
}

/* ---- a blocked page never heals through the api either ---- */
{
  const r = await scrape(SPEC, opts({ html: page("blocked.html"), heal: true }));
  eq(r.cause, "BLOCKED", "diagnosed as blocked");
  eq(r.healed.length, 0, "no selector was touched");
}

/* ---- rows(): the terse form ---- */
{
  const values = await rows(SPEC, opts({ html: page("v1-original.html") }));
  eq(values.length, 3, "rows() returns just the data");

  let threw = null;
  try {
    await rows(SPEC, opts({ html: page("v2-price-moved.html") }));
  } catch (e) {
    threw = e;
  }
  ok(threw instanceof MenderError, "rows() throws rather than returning nulls");
  ok(threw.message.includes("LAYOUT_CHANGE"), "and the message carries the cause");

  const healedValues = await rows(SPEC, opts({ html: page("v2-price-moved.html"), heal: true }));
  eq(healedValues.length, 3, "rows() with healing returns data instead of throwing");
}

/* ---- heal: "write" persists, and needs a file to write to ---- */
{
  const dir = mkdtempSync(join(tmpdir(), "mender-api-"));
  const specPath = join(dir, "pricing.json");
  copyFileSync("examples/scrapers/pricing.json", specPath);

  const r = await scrape(specPath, opts({ html: page("v2-price-moved.html"), heal: "write" }));
  eq(r.ok, true, "the run recovers");
  const onDisk = JSON.parse(read(specPath, "utf8"));
  eq(
    onDisk.fields.price.selector,
    '.amount, [data-testid="price-value"]',
    'heal: "write" persisted the repair to the spec file',
  );

  let threw = null;
  try {
    await scrape(SPEC, opts({ html: page("v2-price-moved.html"), heal: "write" }));
  } catch (e) {
    threw = e;
  }
  ok(threw instanceof MenderError, 'heal: "write" on an inline spec is refused, not silently ignored');
  rmSync(dir, { recursive: true, force: true });
}

/* ---- spec resolution ---- */
{
  eq(resolveSpec("examples/scrapers/pricing.json").name, "pricing", "a path resolves to a spec");
  eq(resolveSpec(SPEC).row, ".pricing-card", "an object passes through");

  let threw = null;
  try {
    defineSpec({ name: "x", url: "not a url", fields: {} });
  } catch (e) {
    threw = e;
  }
  ok(threw instanceof ConfigError, "defineSpec validates rather than trusting the caller");
}

/* ---- scrapeAll over a directory ---- */
{
  const results = await scrapeAll("examples/scrapers", opts({ html: page("v1-original.html") }));
  eq(Object.keys(results).join(), "pricing", "keyed by spec name");
  eq(results.pricing.ok, true, "and carries each result");
}

/* ---- archiveFirstRun only fires on a live, healthy run ---- */
{
  const dir = mkdtempSync(join(tmpdir(), "mender-arch-"));
  mkdirSync(join(dir, "pricing"), { recursive: true });
  const r = await scrape(SPEC, {
    fixtures: dir,
    html: page("v1-original.html"),
    archiveFirstRun: true,
  });
  eq(r.ok, true, "the run is healthy");
  // With --html there is no live page to archive, so nothing is written.
  const { readdirSync } = await import("node:fs");
  eq(readdirSync(join(dir, "pricing")).length, 0, "a local-html run archives nothing");
  rmSync(dir, { recursive: true, force: true });
}
