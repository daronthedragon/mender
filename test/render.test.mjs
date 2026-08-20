import { eq, ok, section } from "./harness.mjs";
import { createServer } from "node:http";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSpec } from "../dist/config.js";
import { runCheck, runRepair } from "../dist/repair.js";
import { fetchPages } from "../dist/fetch.js";
import { playwrightFetcher, BrowserUnavailableError, INSTALL_HINT } from "../dist/browser.js";
import { verifyCandidate, kindOf } from "../dist/verify.js";
import { parse } from "../dist/html.js";

section("browser rendering");

const page = (f) => readFileSync(`examples/pages/${f}`, "utf8");

// The page a client-rendered site returns to a plain fetch: a shell.
const SHELL = `<!doctype html><html><body><div id="root"></div>
<script src="/app.js"></script></body></html>`;

const server = createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end(SHELL);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

const spec = {
  name: "pricing",
  url: `${base}/pricing`,
  row: ".pricing-card",
  fields: {
    plan: { selector: ".plan-title", type: "string" },
    price: { selector: ".amount", type: "number", min: 1 },
  },
  expect: { rows: { min: 2, max: 8 } },
  render: { waitFor: ".pricing-card", waitMs: 50 },
};

/** Stands in for Playwright: records what it was asked for, returns hydrated html. */
function fakeBrowser(html = page("v1-original.html")) {
  const calls = [];
  let closed = false;
  return {
    name: "fake-browser",
    calls,
    get closed() {
      return closed;
    },
    async fetch(url, opts = {}) {
      calls.push({ url, opts });
      return { status: 200, finalUrl: url, html, ms: 5 };
    },
    async close() {
      closed = true;
    },
  };
}

{
  // Without a browser the page is an empty shell and must NOT look repairable.
  const res = await runCheck(spec);
  eq(res.cause, "EMPTY", "a client-rendered shell is EMPTY, not a layout change");
  eq(res.rows.length, 0, "and yields no rows");
}

{
  const browser = fakeBrowser();
  const res = await runCheck(spec, { fetcher: browser });
  eq(res.cause, "OK", "with a renderer the same spec passes");
  eq(res.rows.length, 3, "and extracts the hydrated rows");
  eq(browser.calls.length, 1, "the renderer was used once");
  eq(browser.calls[0].opts.waitFor, ".pricing-card", "the spec's waitFor reached the renderer");
  eq(browser.calls[0].opts.waitMs, 50, "as did waitMs");
}

{
  // Pagination and auth must behave identically on the rendered path.
  process.env.MENDER_RENDER_TOKEN = "Bearer r3nder";
  const paged = {
    ...spec,
    auth: { headerEnv: { Authorization: "MENDER_RENDER_TOKEN" } },
    paginate: { urlTemplate: `${base}/p{page}`, maxPages: 3 },
  };
  const browser = fakeBrowser();
  const res = await fetchPages(paged, { fetcher: browser });
  eq(res.pages.length, 3, "the renderer is paginated like plain fetch");
  eq(browser.calls.length, 3, "three renders");
  eq(
    browser.calls.every((c) => c.opts.headers.authorization === "Bearer r3nder"),
    true,
    "every rendered page carried the credential",
  );
  delete process.env.MENDER_RENDER_TOKEN;
}

{
  // A render failure must degrade like a transport failure, never to a repair.
  const broken = {
    name: "broken-browser",
    async fetch(url) {
      return { status: 0, finalUrl: url, html: "<!-- render failed: TimeoutError -->", ms: 1 };
    },
    async close() {},
  };
  const res = await runCheck(spec, { fetcher: broken });
  eq(res.cause, "HTTP_ERROR", "a failed render is an error, not a repairable page");

  const outcome = await runRepair(spec, { fixturesRoot: "examples/fixtures", fetcher: broken });
  eq(outcome.attempted, false, "and no repair is attempted against it");
}

await new Promise((r) => server.close(r));

/* ---- the real thing, when it is installed ---- */
{
  ok(INSTALL_HINT.includes("optional peer dependency"), "the install hint states mender itself needs none");

  let real = null;
  let err = null;
  try {
    real = await playwrightFetcher();
  } catch (e) {
    err = e;
  }

  if (!real) {
    // Playwright absent is the expected state for a default install and for CI.
    ok(err instanceof BrowserUnavailableError, "a missing playwright raises BrowserUnavailableError");
    ok(err.message.includes("npm install playwright"), "and the message says how to fix it");
  } else {
    // A page whose rows exist only after script execution.
    const spa = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<!doctype html><html><body><div id="root"></div><script>
        const plans = [["Starter",19],["Pro",49],["Scale",199]];
        setTimeout(() => {
          document.getElementById("root").innerHTML = '<section>' + plans.map(([n,p]) =>
            '<div class="pricing-card"><h3 class="plan-title">'+n+'</h3>'+
            '<p class="amount">$'+p+'</p></div>').join('') + '</section>';
        }, 120);
      </script></body></html>`);
    });
    await new Promise((r) => spa.listen(0, "127.0.0.1", r));
    const spaSpec = {
      ...spec,
      url: `http://127.0.0.1:${spa.address().port}/pricing`,
      render: { waitFor: ".pricing-card" },
    };

    const plain = await runCheck(spaSpec);
    eq(plain.cause, "EMPTY", "a real client-rendered page is EMPTY to plain fetch");
    eq(plain.rows.length, 0, "with no rows");

    const rendered = await runCheck(spaSpec, { fetcher: real });
    eq(rendered.cause, "OK", "and OK once actually rendered by chromium");
    eq(rendered.rows.length, 3, "with all three rows");
    eq(rendered.rows[1].plan, "Pro", "and the right data");
    eq(rendered.rows[2].price, 199, "including parsed numbers");

    await real.close();
    await new Promise((r) => spa.close(r));
  }
}

section("continuity: reformats versus wrong elements");

const pricing = loadSpec("examples/scrapers/pricing.json");
const golden = [{ source: "2026-07-02", doc: parse(page("v1-original.html")) }];

eq(kindOf("19 dollars"), "currency", "a currency word counts as currency");
eq(kindOf("19 EUR"), "currency", "so does a currency code");
eq(kindOf("4.8"), "numeric", "a bare rating is still numeric");

function tryCandidate(html, selector) {
  return verifyCandidate({
    spec: pricing,
    candidate: { target: "price", selector, score: 1, reason: "test", via: "test" },
    live: { source: "live", doc: parse(html) },
    goldens: golden,
  });
}

{
  // The false rejection named in v0.2's README: same values, new formatting.
  const reformatted = page("v1-original.html").replace(
    /<p class="amount">\$(\d+)<\/p>/g,
    '<p class="price-text">$1.00</p>',
  );
  const result = tryCandidate(reformatted, ".price-text");
  const gate = result.passes.find((p) => p.source === "continuity");
  eq(gate.ok, true, `a pure reformat is now accepted: ${gate.detail}`);
  eq(result.verified, true, "and the candidate clears every gate");
}

{
  // The trap must still be refused: a rating is not a reformatted price.
  const result = tryCandidate(page("v4-price-gone-trap.html"), ".rating-value");
  const gate = result.passes.find((p) => p.source === "continuity");
  eq(gate.ok, false, "a different number is still rejected");
  ok(gate.detail.includes("median moved"), `and the reason names the magnitude: ${gate.detail}`);
  eq(result.verified, false, "so the candidate is not accepted");
}

section("drift cold start");

{
  // A brand-new scraper has no run history, but its fixtures are already dated
  // observations of the same page.
  const root = mkdtempSync(join(tmpdir(), "mender-cold-"));
  const taxed = await runCheck(pricing, {
    html: page("v6-prices-with-tax.html"),
    historyRoot: root,
    baselineFrom: "examples/fixtures",
  });
  eq(taxed.cause, "OK", "the contract passes");
  ok(
    taxed.drift.some((d) => d.code === "MAGNITUDE_SHIFT"),
    "drift is detected on the very first run, seeded from fixtures",
  );

  const noSeed = await runCheck(pricing, {
    html: page("v6-prices-with-tax.html"),
    historyRoot: root,
  });
  eq(noSeed.drift.length, 0, "without a fixture baseline the first run is still blind");
  rmSync(root, { recursive: true, force: true });
}
