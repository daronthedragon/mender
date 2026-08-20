import { eq, ok, section } from "./harness.mjs";
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  writeRows,
  diffRows,
  keyOf,
  csvCell,
  toCsv,
  formatFor,
  resolvePath,
  validateOutput,
  loadSeen,
  SinkError,
} from "../dist/sink.js";
import { loadSpec } from "../dist/config.js";
import { scrape } from "../dist/api.js";

section("output formats");

eq(csvCell("plain"), "plain", "a plain value needs no quoting");
eq(csvCell("has,comma"), '"has,comma"', "a comma forces quotes");
eq(csvCell('say "hi"'), '"say ""hi"""', "quotes are doubled");
eq(csvCell("two\nlines"), '"two\nlines"', "a newline forces quotes");
eq(csvCell(null), "", "null is empty");
eq(csvCell(undefined), "", "so is undefined");
eq(csvCell(["a", "b"]), "a; b", "a list is joined readably");
eq(csvCell(0), "0", "zero is not treated as empty");

eq(
  toCsv([{ a: 1, b: "x,y" }], ["a", "b"]),
  'a,b\n1,"x,y"\n',
  "a csv has a header and escaped cells",
);

eq(formatFor("out.csv"), "csv", "format inferred from .csv");
eq(formatFor("out.json"), "json", "and from .json");
eq(formatFor("out.jsonl"), "jsonl", "and from .jsonl");
eq(formatFor("out.txt"), "jsonl", "anything else defaults to jsonl");
eq(formatFor("out.csv", "json"), "json", "an explicit format wins");

{
  const spec = { name: "prices", url: "https://x.com", fields: {} };
  const at = new Date("2026-08-21T10:00:00Z");
  eq(resolvePath("data/{name}.jsonl", spec, at), "data/prices.jsonl", "{name} is substituted");
  eq(resolvePath("data/{date}/{name}.csv", spec, at), "data/2026-08-21/prices.csv", "{date} too");
}

section("change tracking");

const at = "2026-08-21T10:00:00Z";

eq(keyOf({ a: 1, b: 2 }), '{"a":1,"b":2}', "without a key the whole row is the identity");
eq(keyOf({ plan: "Pro", price: 9 }, "plan"), '["Pro"]', "a named key uses just that field");
eq(keyOf({ a: "x", b: "y" }, ["a", "b"]), '["x","y"]', "a composite key uses all of them");

{
  const first = diffRows([{ plan: "A", price: 1 }, { plan: "B", price: 2 }], {}, "plan", at);
  eq(first.counts.added, 2, "everything is new on the first run");
  eq(first.events.length, 2, "and every row is an event");
  eq(first.events[0]._change, "added", "marked as added");

  const same = diffRows([{ plan: "A", price: 1 }, { plan: "B", price: 2 }], first.next, "plan", at);
  eq(same.counts.unchanged, 2, "an unchanged run produces nothing");
  eq(same.events.length, 0, "no events at all");

  const moved = diffRows([{ plan: "A", price: 5 }, { plan: "B", price: 2 }], first.next, "plan", at);
  eq(moved.counts.updated, 1, "one row changed");
  eq(moved.counts.unchanged, 1, "the other did not");
  eq(moved.events[0]._before.price, 1, "the previous value is kept");
  eq(moved.events[0].price, 5, "alongside the new one");

  const gone = diffRows([{ plan: "A", price: 5 }], moved.next, "plan", at);
  eq(gone.counts.removed, 1, "a row that disappeared is counted");
  eq(gone.events.length, 0, "but removal is not an event — it may be a paging artefact");
}

{
  // Identity by key, not by position: reordering is not a change.
  const first = diffRows([{ plan: "A", price: 1 }, { plan: "B", price: 2 }], {}, "plan", at);
  const reordered = diffRows([{ plan: "B", price: 2 }, { plan: "A", price: 1 }], first.next, "plan", at);
  eq(reordered.counts.unchanged, 2, "reordered rows are recognised as the same records");
  eq(reordered.events.length, 0, "and produce no spurious change events");
}

section("writing");

const spec = loadSpec("examples/scrapers/pricing.json");
const rows = [
  { plan: "Starter", price: 19, features: ["a", "b"] },
  { plan: "Pro", price: 49, features: ["c"] },
];

function tmp() {
  return mkdtempSync(join(tmpdir(), "mender-sink-"));
}

{
  const dir = tmp();
  const path = join(dir, "out.csv");
  const r = writeRows(rows, spec, { path }, { stateDir: dir });
  eq(r.format, "csv", "csv chosen from the extension");
  eq(r.written, 2, "both rows written");
  const text = readFileSync(path, "utf8");
  ok(text.startsWith("plan,price,features\n"), "header comes from the spec's field order");
  ok(text.includes("Starter,19,a; b"), `list cell rendered readably: ${text.split("\n")[1]}`);

  // A snapshot has no memory: writing again replaces, it does not grow.
  writeRows(rows, spec, { path }, { stateDir: dir });
  eq(readFileSync(path, "utf8").split("\n").filter(Boolean).length, 3, "still header plus two rows");
  rmSync(dir, { recursive: true, force: true });
}

{
  const dir = tmp();
  const path = join(dir, "out.jsonl");
  writeRows(rows, spec, { path, mode: "append", key: "plan" }, { stateDir: dir });
  writeRows(rows, spec, { path, mode: "append", key: "plan" }, { stateDir: dir });
  eq(readFileSync(path, "utf8").trim().split("\n").length, 2, "append does not duplicate seen rows");

  const more = writeRows(
    [...rows, { plan: "Scale", price: 199, features: [] }],
    spec,
    { path, mode: "append", key: "plan" },
    { stateDir: dir },
  );
  eq(more.written, 1, "only the genuinely new row is appended");
  eq(readFileSync(path, "utf8").trim().split("\n").length, 3, "three records in total");
  rmSync(dir, { recursive: true, force: true });
}

{
  const dir = tmp();
  const path = join(dir, "changes.jsonl");
  writeRows(rows, spec, { path, mode: "changes", key: "plan" }, { stateDir: dir });
  const bumped = [{ plan: "Starter", price: 21, features: ["a", "b"] }, rows[1]];
  const r = writeRows(bumped, spec, { path, mode: "changes", key: "plan" }, { stateDir: dir });

  eq(r.changes.updated, 1, "one price moved");
  const lines = readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  eq(lines.length, 3, "two added events plus one update");
  const update = lines[2];
  eq(update._change, "updated", "the third record is an update");
  eq(update.price, 21, "carrying the new value");
  eq(update._before.price, 19, "and the old one");
  ok(update._at.includes("T"), "stamped with when it happened");
  rmSync(dir, { recursive: true, force: true });
}

{
  const dir = tmp();
  const path = join(dir, "changes.csv");
  writeRows(rows, spec, { path, mode: "changes", key: "plan" }, { stateDir: dir });
  writeRows([{ plan: "Starter", price: 21, features: [] }], spec, { path, mode: "changes", key: "plan" }, { stateDir: dir });
  const text = readFileSync(path, "utf8");
  eq(text.split("\n")[0], "_change,_at,plan,price,features", "the change log's csv header names the meta columns");
  eq(text.trim().split("\n").length, 4, "header plus two adds plus one update — the header is not repeated");
  rmSync(dir, { recursive: true, force: true });
}

{
  const dir = tmp();
  let threw = null;
  try {
    writeRows(rows, spec, { path: join(dir, "x.json"), mode: "changes" }, { stateDir: dir });
  } catch (e) {
    threw = e;
  }
  ok(threw instanceof SinkError, "a change log cannot be a single json document");
  rmSync(dir, { recursive: true, force: true });
}

{
  // A corrupt store costs one run of duplicates, not a crash.
  const dir = tmp();
  mkdirSync(join(dir, "pricing"), { recursive: true });
  writeFileSync(join(dir, "pricing", "rows.json"), "{ not json");
  const store = loadSeen(dir, "pricing");
  eq(Object.keys(store.rows).length, 0, "a corrupt seen-store reads as empty");
  const r = writeRows(rows, spec, { path: join(dir, "o.jsonl"), mode: "append", key: "plan" }, { stateDir: dir });
  eq(r.written, 2, "and the run continues");
  rmSync(dir, { recursive: true, force: true });
}

section("output config validation");

const bad = (raw, label) => {
  let threw = false;
  try {
    validateOutput(raw, "test");
  } catch (e) {
    threw = e instanceof SinkError;
  }
  ok(threw, label);
};

bad({}, "output without a path is rejected");
bad({ path: "x", format: "xml" }, "an unknown format is rejected");
bad({ path: "x", mode: "sometimes" }, "an unknown mode is rejected");
bad({ path: "x", mode: "changes", format: "json" }, "changes plus json is rejected up front");
bad({ path: "x", key: 42 }, "a non-string key is rejected");
ok(validateOutput({ path: "x", key: ["a", "b"] }, "test"), "a composite key is accepted");

section("the api only persists a run it trusts");

{
  const dir = tmp();
  const page = (f) => readFileSync(`examples/pages/${f}`, "utf8");
  const output = { path: join(dir, "rows.jsonl"), mode: "changes", key: "plan" };

  const healthy = await scrape(spec, { html: page("v1-original.html"), fixtures: dir, output });
  eq(healthy.ok, true, "a healthy run");
  eq(healthy.output.written, 3, "writes its rows");

  // A broken run must not persist nulls into the pipeline.
  const broken = await scrape(spec, { html: page("v2-price-moved.html"), fixtures: dir, output });
  eq(broken.ok, false, "a broken run");
  eq(broken.output, undefined, "writes nothing at all");
  eq(readFileSync(output.path, "utf8").trim().split("\n").length, 3, "the log is untouched");

  // A repaired run is a good run, and its data is worth keeping. The reference
  // fixture is copied in so repair and the seen-store share one directory —
  // the store lives under `fixtures`, so pointing them apart would make every
  // row look new.
  const { copyFileSync } = await import("node:fs");
  copyFileSync("examples/fixtures/pricing/2026-07-02.html", join(dir, "pricing", "2026-07-02.html"));
  const repaired = await scrape(spec, {
    html: page("v2-price-moved.html"),
    fixtures: dir,
    heal: true,
    output: { ...output },
  });
  eq(repaired.ok, true, "healing recovers it");
  eq(repaired.output.changes.updated, 3, "and the three moved prices are recorded as changes");

  const events = readFileSync(output.path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const last = events[events.length - 1];
  eq(last._change, "updated", "the repaired run appended updates");
  ok(last._before.price !== last.price, `with both values: ${last._before.price} -> ${last.price}`);
  ok(last.price !== null, "and no nulls, because the scraper was repaired first");

  eq(await scrape(spec, { html: page("v1-original.html"), fixtures: dir, output: false }).then((r) => r.output),
     undefined, "output:false disables writing entirely");
  rmSync(dir, { recursive: true, force: true });
}
