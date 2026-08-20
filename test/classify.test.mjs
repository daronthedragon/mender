import { eq, section } from "./harness.mjs";
import { readFileSync } from "node:fs";
import { parse } from "../dist/html.js";
import { classify, shouldRepair } from "../dist/classify.js";
import { validate } from "../dist/contract.js";
import { extract } from "../dist/extract.js";
import { loadSpec } from "../dist/config.js";

section("cause classification (the safety gate)");

const spec = loadSpec("examples/scrapers/pricing.json");
const page = (f) => readFileSync(`examples/pages/${f}`, "utf8");

function causeOf(html, { status = 200, finalUrl = spec.url } = {}) {
  const doc = parse(html);
  const violations = validate(extract(doc, spec), spec);
  return classify({ status, finalUrl, html, ms: 1 }, doc, spec, violations).cause;
}

eq(causeOf(page("v1-original.html")), "OK", "a healthy page classifies as OK");
eq(causeOf(page("v2-price-moved.html")), "LAYOUT_CHANGE", "a served page failing its contract is a layout change");
eq(causeOf(page("v3-rows-renamed.html")), "LAYOUT_CHANGE", "a renamed row container is a layout change");

// Everything below must NOT be treated as a layout change, because repairing
// selectors against these pages is how a scraper gets taught to extract garbage.
eq(causeOf(page("blocked.html")), "BLOCKED", "a challenge page is BLOCKED, not a layout change");
eq(causeOf(page("v1-original.html"), { status: 403 }), "BLOCKED", "HTTP 403 is BLOCKED");
eq(causeOf(page("v1-original.html"), { status: 429 }), "BLOCKED", "HTTP 429 is BLOCKED");
eq(causeOf("<html><body><h1>Not Found</h1></body></html>", { status: 404 }), "HTTP_ERROR", "HTTP 404 is an error");
eq(causeOf("<!-- fetch failed -->", { status: 0 }), "HTTP_ERROR", "a transport failure is an error, never a page");
eq(causeOf("<html><body></body></html>"), "EMPTY", "a page with no text is EMPTY");
eq(
  causeOf(page("v2-price-moved.html"), { finalUrl: "https://example.com/plans" }),
  "REDIRECTED",
  "a page served from a different path is REDIRECTED",
);

// Redirect normalisation: these are the same target, not a redirect.
eq(
  causeOf(page("v1-original.html"), { finalUrl: "https://www.example.com/pricing/" }),
  "OK",
  "www and a trailing slash are not a redirect",
);

// A short challenge phrase in a large ordinary page must not trip the detector.
{
  const long = page("v1-original.html").replace(
    "<h1>Plans that scale with you</h1>",
    "<h1>Plans that scale with you</h1><p>Our access denied page explains rate limit exceeded errors.</p>" +
      "<p>" + "filler ".repeat(4000) + "</p>",
  );
  eq(causeOf(long), "OK", "challenge wording inside a large real page is not a block");
}

eq(shouldRepair("LAYOUT_CHANGE"), true, "only a layout change may trigger repair");
for (const cause of ["OK", "BLOCKED", "HTTP_ERROR", "REDIRECTED", "EMPTY"]) {
  eq(shouldRepair(cause), false, `${cause} never triggers repair`);
}
