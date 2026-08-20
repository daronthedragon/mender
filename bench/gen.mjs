/**
 * Synthetic page generator for the benchmark.
 *
 * Shape mirrors what mender actually sees in the wild: a repeating row
 * container with a dozen field elements inside, plus chrome (header, nav,
 * sidebar, footer) that a selector has to walk past.
 */

const WORDS = [
  "alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel",
  "india", "juliet", "kilo", "lima", "mike", "november", "oscar", "papa",
];

/** Deterministic PRNG so every run benches the same bytes. */
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

export function generatePage({ rows = 200, fields = 12, seed = 7, priceClass = "amount" } = {}) {
  const rand = rng(seed);
  const word = () => WORDS[Math.floor(rand() * WORDS.length)];
  const out = [];

  out.push("<!doctype html>");
  out.push('<html lang="en"><head><meta charset="utf-8">');
  out.push("<title>Catalogue — Bench Co</title>");
  out.push('<script>var cfg = {a: "<div class=\'amount\'>not real</div>"};</script>');
  out.push("<style>.amount{font-weight:700}</style>");
  out.push("</head><body>");

  out.push('<header class="site-header"><nav class="main-nav"><ul>');
  for (let i = 0; i < 8; i++) {
    out.push(`<li class="nav-item"><a class="nav-link" href="/${word()}">${word()}</a></li>`);
  }
  out.push("</ul></nav></header>");

  out.push('<aside class="sidebar">');
  for (let i = 0; i < 20; i++) {
    out.push(`<div class="facet facet-${i % 5}"><span class="facet-label">${word()}</span>`);
    out.push(`<span class="facet-count">${Math.floor(rand() * 500)}</span></div>`);
  }
  out.push("</aside>");

  out.push('<main class="page"><h1>Catalogue</h1><section class="product-grid">');

  for (let r = 0; r < rows; r++) {
    out.push(`<article class="product-card" data-sku="SKU-${1000 + r}">`);
    out.push(`<h3 class="title-heading"><a class="title-link" href="/p/${r}">${word()} ${word()}</a></h3>`);
    out.push(`<p class="${priceClass}">$${(19 + r * 3.5).toFixed(2)}</p>`);
    out.push(`<span class="rating" data-testid="rating">${(1 + rand() * 4).toFixed(1)}</span>`);
    out.push(`<span class="reviews">${Math.floor(rand() * 900)} reviews</span>`);
    for (let f = 4; f < fields; f++) {
      out.push(
        `<div class="meta meta-${f}"><span class="meta-key">${word()}</span>` +
          `<span class="meta-value f-${f}">${word()} ${Math.floor(rand() * 1000)}</span></div>`,
      );
    }
    out.push('<ul class="features">');
    for (let k = 0; k < 4; k++) out.push(`<li class="feature">${word()} ${word()}`);
    out.push("</ul>");
    out.push(`<a class="cta" href="/buy/${r}">Buy</a>`);
    out.push("</article>");
  }

  out.push("</section></main>");
  out.push('<footer class="site-footer"><p>&copy; 2026 Bench Co &mdash; all rights reserved.</p></footer>');
  out.push("</body></html>");
  return out.join("\n");
}

export const BENCH_SPEC = {
  name: "bench",
  url: "https://example.com/catalogue",
  row: ".product-card",
  fields: {
    title: { selector: ".title-link", type: "string" },
    price: { selector: ".amount", type: "number", min: 1 },
    rating: { selector: "[data-testid=rating]", type: "number", min: 0 },
    reviews: { selector: ".reviews", type: "string" },
    m4: { selector: ".f-4", type: "string" },
    m5: { selector: ".f-5", type: "string" },
    m6: { selector: ".f-6", type: "string" },
    m7: { selector: ".f-7", type: "string" },
    m8: { selector: ".f-8", type: "string" },
    m9: { selector: ".f-9", type: "string" },
    m10: { selector: ".f-10", type: "string" },
    features: { selector: "li.feature", type: "list", minItems: 3 },
  },
  expect: { rows: { min: 2, max: 500 } },
};
