/**
 * Differential check for the candidate-narrowing index in src/select.ts.
 *
 * `matches(el, sel, root)` does no narrowing at all, so
 * `descendants(root).filter((el) => matches(el, sel, root))` is exactly the
 * implementation querySelectorAll had before the index existed. Every selector
 * is run against every root three times: the first call is served by a linear
 * scan (the index is only built on the second query against a root), the later
 * ones by the index. All three must equal the oracle, element for element and
 * in the same order.
 *
 *   node bench/verify-equivalence.mjs
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { generatePage } from "./gen.mjs";

const { parse, descendants } = await import("../dist/html.js");
const { querySelectorAll, matches } = await import("../dist/select.js");

const SELECTORS = [
  "*", "div", "span", "li", "a", "p", "h3", "article", "ul",
  ".product-card", ".amount", ".meta", ".meta-value", ".feature", ".cta",
  ".pricing-card", ".plan-title", ".features", ".missing", ".nav-item",
  "#nope", "div#nope", "[data-sku]", "[data-testid]", '[data-testid="rating"]',
  "[href]", '[href^="/"]', '[href$="pro"]', '[href*="signup"]', '[class~="meta"]',
  "[lang|=en]", "div.meta span", "div.meta > span", ".product-card .meta-value",
  ".product-card > h3 > a", "li + li", "li ~ li", "span + span",
  "li:first-child", "li:last-child", "li:only-child", "li:nth-child(2)",
  "li:nth-child(odd)", "li:nth-child(even)", "li:nth-child(2n+1)", "li:nth-child(-n+3)",
  "span:not(.meta-key)", "div:not(.meta)", "a:hover", "p::before",
  ".amount, [data-testid=rating]", "div, span", ".missing, .amount",
  "li, .cta, [data-sku]", "ul li, ol li", "*, div",
  ".product-card .features li:nth-child(2)", "article[data-sku] .meta .meta-value",
  ".meta-key + .meta-value", "h3.title-heading a[href]",
];

const docs = [];
docs.push(["synthetic", parse(generatePage({ rows: 12, fields: 12, seed: 3 }))]);
docs.push(["synthetic-renamed", parse(generatePage({ rows: 9, fields: 6, seed: 11, priceClass: "price-value" }))]);
const pagesDir = join("examples", "pages");
for (const f of readdirSync(pagesDir).filter((x) => x.endsWith(".html"))) {
  docs.push([f, parse(readFileSync(join(pagesDir, f), "utf8"))]);
}
for (const root of ["examples/fixtures", "examples/fixtures-stale"]) {
  for (const dir of readdirSync(root)) {
    for (const f of readdirSync(join(root, dir))) {
      docs.push([`${root}/${dir}/${f}`, parse(readFileSync(join(root, dir, f), "utf8"))]);
    }
  }
}

let checks = 0;
let failures = 0;

function oracle(root, sel) {
  return descendants(root).filter((el) => matches(el, sel, root));
}

function same(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

for (const [name, doc] of docs) {
  // The document itself, plus a spread of interior elements as query roots —
  // repair queries inside rows, not just at the top.
  const all = descendants(doc);
  const roots = [doc];
  for (let i = 0; i < all.length; i += Math.max(1, Math.floor(all.length / 25))) roots.push(all[i]);

  for (const root of roots) {
    for (const sel of SELECTORS) {
      const want = oracle(root, sel);
      for (let pass = 0; pass < 3; pass++) {
        const got = querySelectorAll(root, sel);
        checks++;
        if (!same(want, got)) {
          failures++;
          if (failures <= 10) {
            console.error(
              `MISMATCH ${name} root <${root.tag}> selector ${JSON.stringify(sel)} pass ${pass}: ` +
                `expected ${want.length} got ${got.length}`,
            );
          }
        }
      }
    }
  }
}

console.log(`${docs.length} documents, ${SELECTORS.length} selectors, ${checks} comparisons`);
console.log(failures === 0 ? "querySelectorAll agrees with the unnarrowed oracle everywhere" : `${failures} MISMATCHES`);
process.exit(failures === 0 ? 0 : 1);
