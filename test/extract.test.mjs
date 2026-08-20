import { eq, section } from "./harness.mjs";
import { parse } from "../dist/html.js";
import { extract, parseNumber, toRows } from "../dist/extract.js";

section("extraction");

eq(parseNumber("$19"), 19, "currency prefix");
eq(parseNumber("$1,299.00"), 1299, "thousands separator with decimals");
eq(parseNumber("1.299,50 kr"), 1299.5, "european format, comma as decimal");
eq(parseNumber("49.99 USD"), 49.99, "trailing currency code");
eq(parseNumber("1,50"), 1.5, "bare comma decimal");
eq(parseNumber("2,500"), 2500, "comma before exactly three digits is a thousands group");
eq(parseNumber("-12.5%"), -12.5, "negative and percent");
eq(parseNumber("Free"), null, "text with no number");
eq(parseNumber(""), null, "empty string");
eq(parseNumber("  "), null, "whitespace only");

const SPEC = {
  name: "t",
  url: "https://example.com/",
  row: ".item",
  fields: {
    title: { selector: "h3", type: "string", required: true },
    price: { selector: ".price", type: "number", required: true, min: 1 },
    tags: { selector: "li", type: "list", minItems: 2 },
    link: { selector: "a", type: "string", attr: "href", required: true },
  },
};

const DOC = parse(`
<div class="item"><h3>Alpha</h3><span class="price">$10</span>
  <ul><li>x<li>y</ul><a href="/a">go</a></div>
<div class="item"><h3>Beta</h3><span class="price">$20</span>
  <ul><li>p<li>q<li>r</ul><a href="/b">go</a></div>`);

const rows = toRows(extract(DOC, SPEC));
eq(rows.length, 2, "one row per matching row element");
eq(rows[0].title, "Alpha", "string field");
eq(rows[0].price, 10, "number field is coerced");
eq(rows[0].tags.join("|"), "x|y", "list field collects every match");
eq(rows[1].tags.length, 3, "list length varies per row");
eq(rows[0].link, "/a", "attr option reads the attribute, not the text");

// Field selectors are scoped to their row.
eq(rows[1].title, "Beta", "row two does not read row one's title");

// With no row selector the document is a single row.
{
  const single = toRows(extract(DOC, { ...SPEC, row: undefined }));
  eq(single.length, 1, "no row selector means one row for the whole document");
  eq(single[0].title, "Alpha", "the first match wins for a scalar field");
}

// A missing field yields null rather than throwing.
{
  const missing = toRows(extract(parse(`<div class="item"><h3>Solo</h3></div>`), SPEC));
  eq(missing[0].price, null, "an unmatched number field is null");
  eq(missing[0].tags.length, 0, "an unmatched list field is empty");
}
