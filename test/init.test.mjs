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

/* ---- the invariant: a generated spec passes the page it came from ---- */
{
  // This was violated on a real site. inferSpec looked at every match while
  // extraction reads only the first one for a scalar and drops empties from a
  // list, so the generated contract asserted things the extractor could never
  // produce. Asserting the invariant over every bundled page keeps the two
  // halves in step, whatever changes later.
  const { readdirSync } = await import("node:fs");
  const pages = readdirSync("examples/pages").filter((f) => f.endsWith(".html"));
  let inferred = 0;

  for (const file of pages) {
    const html = readFileSync(`examples/pages/${file}`, "utf8");
    const result = inferSpec(html, "https://example.com/x", "gen");
    if (!result) continue;
    inferred++;
    const check = await runCheck(result.spec, { html });
    // Violations, not cause: blocked.html is a challenge page and classifies
    // BLOCKED whatever spec is pointed at it, which is orthogonal to whether
    // the generated contract describes what the extractor produces.
    eq(check.violations.length, 0, `the spec inferred from ${file} has no violations on ${file}`);
  }
  ok(inferred >= 5, `${inferred} of ${pages.length} bundled pages yielded a spec`);
}

/* ---- the real-world shapes that broke it ---- */
{
  const html = readFileSync("examples/pages/v8-realworld-shapes.html", "utf8");
  const result = inferSpec(html, "https://example.com/shop", "shop");
  ok(result, "a page of real-world shapes yields a spec");
  eq(result.rowCount, 4, "all four products found");

  const names = Object.keys(result.spec.fields);
  const selectors = Object.values(result.spec.fields).map((f) => f.selector);

  const bareLink = Object.values(result.spec.fields).find(
    (f) => f.selector === "a" && f.type !== "list",
  );
  eq(bareLink, undefined, "no scalar field is aimed at an <a> whose first match is an image link");

  const check = await runCheck(result.spec, { html });
  const rows = check.rows;
  const constantField = names.find((n) => new Set(rows.map((r) => JSON.stringify(r[n]))).size === 1);
  eq(constantField, undefined, `no field holds the same value in every row: ${names.join(", ")}`);

  eq(check.cause, "OK", "and the generated spec passes its own page");
  ok(selectors.includes(".price"), `the price column is found: ${selectors.join(" | ")}`);
  const price = Object.entries(result.spec.fields).find(([, f]) => f.selector === ".price");
  eq(price[1].type, "number", "and typed as a number despite the currency symbol");
  eq(rows[0][price[0]], 51.77, "with the value parsed correctly");
}

/* ---- optional columns, and not choosing the wrapper over the records ---- */
{
  // Both shapes were found by pointing init at real sites, not by imagining
  // them. See the comment at the top of the fixture.
  const html = readFileSync("examples/pages/v9-optional-and-nested.html", "utf8");
  const result = inferSpec(html, "https://example.com/board", "board");
  ok(result, "the page yields a spec");

  // The wrapper .board contains every value on the page. Choosing it would
  // give one record instead of five.
  eq(result.rowCount, 5, `all five records found, not the wrapper: row=${result.spec.row}`);
  ok(result.spec.row !== ".board", "the outer wrapper is not mistaken for a record");
  ok(!result.spec.row.includes("nth-child"), `the row selector is not positional: ${result.spec.row}`);

  // The fourth record has no badge and no tags.
  const optional = Object.entries(result.spec.fields).filter(
    ([, f]) => f.selector === ".badge" || f.selector === "li",
  );
  for (const [name, field] of optional) {
    eq(field.required, false, `${name} is optional, because one record lacks it`);
    eq(field.minItems, undefined, `${name} carries no minItems it cannot meet on every record`);
  }

  const check = await runCheck(result.spec, { html });
  eq(check.violations.length, 0, "and the generated spec has no violations on its own page");
  eq(check.rows.length, 5, "extracting all five records");
}

/* ---- tables: header-named columns, and the shapes real tables have ---- */
{
  const html = readFileSync("examples/pages/v10-tables.html", "utf8");
  const result = inferSpec(html, "https://example.com/stock", "stock");
  ok(result, "a table page yields a spec");
  eq(result.rowCount, 5, "five data rows, not six — the header is not a record");

  const names = Object.keys(result.spec.fields);
  ok(names.includes("part"), `columns are named from the header: ${names.join(", ")}`);
  ok(names.includes("supplier"), "including supplier");
  ok(names.includes("price"), "and price");

  // Each row opens with <th scope="row">, so the first value is not a <td>.
  eq(result.spec.fields.part.selector, "th:nth-child(1)", "a row-header cell is addressed as th, not td");
  eq(result.spec.fields.supplier.selector, "td:nth-child(2)", "and the first td sits at position 2");
  eq(result.spec.fields.price.type, "number", "a numeric column is typed as a number");

  const check = await runCheck(result.spec, { html });
  eq(check.violations.length, 0, "the generated spec has no violations on its own page");
  eq(check.rows.length, 5, "extracting five records");
  eq(check.rows[0].part, "Aluminium bracket", "with the row header as a value");
  eq(check.rows[0].supplier, "Northgate", "and the cells in the right columns");
  eq(check.rows[2].price, 3.02, "and numbers parsed");

  // The footer repeats like records but holds none.
  ok(!result.spec.row.includes("footer"), `the footer is not chosen as the record: ${result.spec.row}`);
  ok(!names.includes("about"), "and its columns are not fields");
}

{
  // A table with no header row at all must not take the table path, or it
  // would treat its first data row as the header.
  const bare =
    `<html><body><table class="t"><tbody>` +
    `<tr class="row"><td class="name">Widget</td><td class="price">$4.50</td></tr>` +
    `<tr class="row"><td class="name">Gizmo</td><td class="price">$9.00</td></tr>` +
    `<tr class="row"><td class="name">Doodad</td><td class="price">$1.25</td></tr>` +
    `</tbody></table></body></html>`;
  const result = inferSpec(bare, "https://example.com/x", "bare");
  ok(result, "a headerless table still yields a spec");
  eq(result.rowCount, 3, "with every row treated as data");
  const check = await runCheck(result.spec, { html: bare });
  eq(check.violations.length, 0, "and it passes its own page");
}

