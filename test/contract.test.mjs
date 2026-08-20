import { eq, ok, section } from "./harness.mjs";
import { parse } from "../dist/html.js";
import { extract } from "../dist/extract.js";
import { validate, brokenFields, rowCountBroken } from "../dist/contract.js";
import { validateSpec, ConfigError } from "../dist/config.js";

section("contracts and config");

const SPEC = {
  name: "t",
  url: "https://example.com/",
  row: ".item",
  fields: {
    title: { selector: "h3", type: "string", required: true },
    price: { selector: ".price", type: "number", required: true, min: 1, max: 1000 },
    tags: { selector: "li", type: "list", minItems: 2 },
  },
  expect: { rows: { min: 2, max: 4 } },
};

const check = (html) => validate(extract(parse(html), SPEC), SPEC);
const row = (title, price, tags = "<li>a<li>b") =>
  `<div class="item"><h3>${title}</h3><span class="price">${price}</span><ul>${tags}</ul></div>`;

eq(check(row("A", "$5") + row("B", "$6")).length, 0, "valid data produces no violations");

// The silent failures a crash-based check would miss.
{
  const v = check("");
  eq(v.length, 1, "zero rows is a violation");
  eq(v[0].code, "ROW_COUNT", "reported as ROW_COUNT");
  ok(rowCountBroken(v), "rowCountBroken detects it");
}

eq(check(row("A", "$5").repeat(5))[0].code, "ROW_COUNT", "too many rows is also a violation");

{
  const v = check(row("", "$5") + row("B", "$6"));
  eq(v[0].code, "FIELD_MISSING", "empty text on a required field");
  eq(v[0].field, "title", "attributed to the right field");
  eq(v[0].row, 0, "and the right row");
}

{
  const v = check(row("A", "Free") + row("B", "$6"));
  eq(v[0].code, "FIELD_TYPE", "matched an element but the value is not a number");
  ok(v[0].detail.includes("Free"), "the detail quotes what it actually found");
}

{
  const v = check(row("A", "$0") + row("B", "$6"));
  eq(v[0].code, "FIELD_RANGE", "a price below min is out of range");
}

{
  const v = check(row("A", "$5000") + row("B", "$6"));
  eq(v[0].code, "FIELD_RANGE", "a price above max is out of range");
}

{
  const v = check(row("A", "$5", "<li>only") + row("B", "$6"));
  eq(v[0].code, "LIST_TOO_SHORT", "a short list is a violation");
}

{
  const v = check(`<div class="item"><h3>A</h3></div><div class="item"><h3>B</h3></div>`);
  eq(brokenFields(v).sort().join(","), "price,tags", "brokenFields lists each failing field once");
}

// A field marked not-required may be absent without complaint.
{
  const relaxed = { ...SPEC, fields: { ...SPEC.fields, price: { ...SPEC.fields.price, required: false } } };
  const v = validate(
    extract(parse(`<div class="item"><h3>A</h3><ul><li>a<li>b</ul></div>`.repeat(2)), relaxed),
    relaxed,
  );
  eq(v.length, 0, "an optional field that matches nothing is fine");
}

/* ---- config validation ---- */
const bad = (raw, label) => {
  let threw = false;
  try {
    validateSpec(raw, "test");
  } catch (e) {
    threw = e instanceof ConfigError;
  }
  ok(threw, label);
};

bad({}, "a spec without a name is rejected");
bad({ name: "a" }, "a spec without a url is rejected");
bad({ name: "a", url: "not a url", fields: {} }, "an invalid url is rejected");
bad({ name: "a", url: "https://x.com", fields: {} }, "a spec with no fields is rejected");
bad(
  { name: "a", url: "https://x.com", fields: { p: { type: "number" } } },
  "a field without a selector is rejected",
);
bad(
  { name: "a", url: "https://x.com", fields: { p: { selector: ".x", type: "money" } } },
  "an unknown field type is rejected",
);

{
  const spec = validateSpec(
    { name: "a", url: "https://x.com", fields: { p: { selector: ".x", type: "string" } } },
    "test",
  );
  eq(spec.fields.p.required, true, "fields are required unless told otherwise");
}

/* ---- auth and pagination config ---- */
const spec = (extra) => ({ name: "a", url: "https://x.com", fields: { p: { selector: ".x", type: "string" } }, ...extra });

bad(spec({ paginate: { next: "a.next" } }), "pagination without maxPages is rejected");
bad(spec({ paginate: { maxPages: 3 } }), "pagination with neither next nor urlTemplate is rejected");
bad(spec({ paginate: { maxPages: 3, urlTemplate: "https://x.com/list" } }), "a urlTemplate without {page} is rejected");
bad(spec({ auth: { basicEnv: { user: "U" } } }), "basic auth without both variable names is rejected");
bad(
  spec({ auth: { headerEnv: { Authorization: "Bearer sk-live-abc123" } } }),
  "a literal secret in headerEnv is rejected — the field names a variable",
);

{
  const ok1 = validateSpec(spec({ paginate: { maxPages: 3, next: "a.next" } }), "test");
  eq(ok1.paginate.maxPages, 3, "a valid paginate block is kept");
  const ok2 = validateSpec(spec({ auth: { headerEnv: { Authorization: "MY_TOKEN" } } }), "test");
  eq(ok2.auth.headerEnv.Authorization, "MY_TOKEN", "a valid auth block is kept");
}
