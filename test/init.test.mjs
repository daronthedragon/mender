import { eq, ok, section } from "./harness.mjs";
import { readFileSync } from "node:fs";
import { inferSpec, formatSpec } from "../dist/init.js";
import { validateSpec } from "../dist/config.js";
import { runCheck } from "../dist/repair.js";

section("spec inference");

const page = (f) => readFileSync(`examples/pages/${f}`, "utf8");
const URL_ = "https://example.com/pricing";

{
  const result = inferSpec(page("v1-original.html"), URL_, "pricing");
  ok(result, "a listing page yields a spec");
  eq(result.rowCount, 3, "it finds the three records");
  eq(result.spec.row, ".pricing-card", "and names the record container");

  const names = Object.keys(result.spec.fields);
  ok(names.includes("plan_title"), `fields are named from the markup: ${names.join(", ")}`);
  ok(names.includes("amount"), "including the price");
  ok(names.includes("features"), "an <li> group is named from its <ul> class, not field_N");
  ok(!names.some((n) => n.startsWith("field_")), "nothing falls back to a numbered name here");

  eq(result.spec.fields.amount.type, "number", "a currency column is typed as a number");
  eq(result.spec.fields.amount.min, 0, "and gets a floor it has never crossed");
  eq(result.spec.fields.features.type, "list", "a repeated element becomes a list");
  eq(result.spec.fields.features.minItems, 3, "with the minimum seen across records");
  eq(result.spec.fields.plan_title.type, "string", "a text column stays a string");

  // Redundancy suppression: li:nth-child(1..n) must not appear beside the list.
  const selectors = Object.values(result.spec.fields).map((f) => f.selector);
  eq(
    selectors.filter((s) => s.includes("nth-child")).length,
    0,
    "no positional duplicates of a column already captured",
  );
  ok(result.notes.some((n) => n.includes("redundant")), "and it says how many it dropped");
}

/* ---- the generated spec has to actually work ---- */
{
  const result = inferSpec(page("v1-original.html"), URL_, "pricing");
  const spec = validateSpec(JSON.parse(formatSpec(result.spec)), "generated");
  const check = await runCheck(spec, { html: page("v1-original.html") });
  eq(check.cause, "OK", "the generated spec passes its own contract");
  eq(check.rows.length, 3, "and extracts every record");
  eq(check.rows[0].amount, 19, "with the right values");
  eq(check.rows[2].plan_title, "Scale", "for every row");
  eq(check.violations.length, 0, "with no violations");
}

/* ---- a generated spec is defended by the rest of the tool ---- */
{
  const result = inferSpec(page("v1-original.html"), URL_, "pricing");
  const broken = await runCheck(result.spec, { html: page("v2-price-moved.html") });
  eq(broken.cause, "LAYOUT_CHANGE", "an inferred spec detects a later break like any other");
  ok(broken.violations.some((v) => v.field === "amount"), "attributing it to the right field");
}

/* ---- refusals ---- */
eq(inferSpec("<html><body><h1>Just a headline</h1></body></html>", URL_, "x"), null,
  "a page with no repeating record yields nothing rather than a guess");
eq(inferSpec("", URL_, "x"), null, "an empty page yields nothing");

{
  // A nav bar repeats too, but carries almost no text and one value each.
  const nav = `<html><body><nav><a href="/a">A</a><a href="/b">B</a><a href="/c">C</a></nav></body></html>`;
  eq(inferSpec(nav, URL_, "x"), null, "a bare navigation list is not mistaken for records");
}

{
  // A table is the other shape records come in.
  const table =
    `<html><body><table><tbody>` +
    `<tr class="row"><td class="name">Widget</td><td class="price">$4.50</td><td class="qty">12</td></tr>` +
    `<tr class="row"><td class="name">Gizmo</td><td class="price">$9.00</td><td class="qty">3</td></tr>` +
    `<tr class="row"><td class="name">Doodad</td><td class="price">$1.25</td><td class="qty">40</td></tr>` +
    `</tbody></table></body></html>`;
  const result = inferSpec(table, "https://example.com/stock", "stock");
  ok(result, "table rows are recognised as records");
  eq(result.rowCount, 3, "all three rows");
  eq(result.spec.fields.price?.type, "number", "a currency cell is a number");
  eq(result.spec.fields.qty?.type, "number", "a bare numeric cell is a number too");
  eq(result.spec.fields.name?.type, "string", "and a text cell is a string");
}

{
  // Build-tool hashes must not become the field names.
  const hashed =
    `<html><body><div class="list">` +
    ["Aluminium bracket", "Brass fitting kit", "Copper pipe length"]
      .map(
        (n, i) =>
          `<div class="css-1x2y3z"><span class="sc-ab12cd34">${n}</span>` +
          `<span class="jsx-9988">$${10 + i}.00</span></div>`,
      )
      .join("") +
    `</div></body></html>`;
  const result = inferSpec(hashed, URL_, "x");
  ok(result, "records are still found when every class is hashed");
  ok(
    Object.keys(result.spec.fields).every((n) => !n.includes("css") && !n.includes("sc_")),
    `hashed classes do not become field names: ${Object.keys(result.spec.fields).join(", ")}`,
  );
}

eq(formatSpec({ name: "a", url: "u", fields: {} }).endsWith("\n"), true, "formatted specs end with a newline");
