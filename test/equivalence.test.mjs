import { eq, ok, section } from "./harness.mjs";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse, descendants } from "../dist/html.js";
import { querySelectorAll, matches } from "../dist/select.js";

section("selector narrowing equivalence");

/**
 * `querySelectorAll` narrows candidates through a class/tag/id/attribute index
 * before matching. `matches(el, sel, root)` does no narrowing at all, so
 * `descendants(root).filter(el => matches(el, sel, root))` is exactly what
 * querySelectorAll did before that index existed — an independent oracle.
 *
 * This is the guard for the index's load-bearing assumption: an element that
 * matches a compound must carry that compound's class, tag, id or attribute
 * name. Add a simple that can match without the element carrying the key —
 * `[attr=v i]`, `:is()`, `:where()` — and querySelectorAll would silently
 * under-match while `matches()` kept working. That divergence would be quiet.
 * This test makes it loud.
 */

const SELECTORS = [
  "*", "div", "span", "li", "a", "p", "h3", "ul",
  ".pricing-card", ".plan-title", ".amount", ".features", ".cta", ".missing",
  "#nope", "div#nope",
  "[data-testid]", '[data-testid="price-value"]', "[href]", '[href^="/"]',
  '[href$="pro"]', '[href*="signup"]', '[class~="features"]', "[lang|=en]",
  "div .amount", "div > .amount", ".pricing-card .plan-title",
  ".pricing-card > h3", "li + li", "li ~ li",
  "li:first-child", "li:last-child", "li:only-child",
  "li:nth-child(2)", "li:nth-child(odd)", "li:nth-child(even)",
  "li:nth-child(2n+1)", "li:nth-child(-n+3)", "li:nth-child(3)",
  "li:not(:first-child)", "div:not(.pricing-card)", "p:not([class])",
  ".plan-title, .amount", "li, p, span", ".missing, .amount",
  "div div div", "body *", "section > div > p",
];

const docs = readdirSync("examples/pages")
  .filter((f) => f.endsWith(".html"))
  .map((f) => ({ name: f, doc: parse(readFileSync(join("examples/pages", f), "utf8")) }));

ok(docs.length >= 5, `${docs.length} example pages available as documents`);

let checks = 0;
let mismatches = 0;
const examples = [];

for (const { name, doc } of docs) {
  // Query roots: the document, plus a spread of interior elements.
  const all = descendants(doc);
  const roots = [doc, ...all.filter((_, i) => i % 7 === 0).slice(0, 20)];

  for (const root of roots) {
    for (const selector of SELECTORS) {
      let want;
      try {
        want = descendants(root).filter((el) => matches(el, selector, root));
      } catch {
        continue; // a selector this engine rejects is not part of the contract
      }
      // Three passes: the index is only built on the second query against a
      // root, so this exercises both the linear path and the indexed one.
      for (let pass = 0; pass < 3; pass++) {
        const got = querySelectorAll(root, selector);
        checks++;
        const same =
          got.length === want.length && got.every((el, i) => el === want[i]);
        if (!same) {
          mismatches++;
          if (examples.length < 3) {
            examples.push(`${name} pass ${pass} "${selector}": want ${want.length}, got ${got.length}`);
          }
        }
      }
    }
  }
}

ok(checks > 5000, `${checks} comparisons run`);
eq(mismatches, 0, `narrowed querySelectorAll matches the unnarrowed oracle${examples.length ? " — " + examples.join(" | ") : ""}`);
