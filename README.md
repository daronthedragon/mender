<p align="center">
  <img src="assets/wordmark.svg" alt="mender" height="86">
</p>

<p align="center"><b>Scrapers that repair themselves — and refuse to, when repairing would be wrong.</b></p>

<p align="center">
  <a href="https://github.com/daronthedragon/mender/actions/workflows/test.yml"><img src="https://github.com/daronthedragon/mender/actions/workflows/test.yml/badge.svg" alt="tests"></a>
  <img src="https://img.shields.io/badge/dependencies-0-14B8A6" alt="zero dependencies">
  <img src="https://img.shields.io/badge/tests-395%20passing-14B8A6" alt="395 tests">
  <img src="https://img.shields.io/badge/node-%E2%89%A520-334155" alt="node >= 20">
  <img src="https://img.shields.io/badge/license-MIT-334155" alt="MIT">
</p>

---

Scrapers don't crash when they break. They return `[]`, or `null`, or yesterday's price, and the pipeline keeps running for three weeks before anyone notices the data is garbage.

`mender` catches that, works out **why** it happened, and only then proposes a selector fix — which has to survive three verification gates before you ever see it.

## Quickstart

```bash
npm install github:daronthedragon/mender
```

```bash
npx mender init https://example.com/pricing
```

```
wrote scrapers/pricing.json
  found 3 repeating records matching ".pricing-card"
  proposed 4 field(s): plan_title, amount, features, cta
  verified: 3 rows pass the generated contract
  archived fixtures/pricing/2026-08-20.html as the first reference
```

That's a working scraper, a contract that describes what good data looks like, and a reference snapshot — without writing a selector. Then:

```bash
npx mender check      # exits non-zero when anything is broken
npx mender repair     # diagnose, propose, verify, show the diff
npx mender drift      # values that changed meaning without breaking anything
```

## Use it as a library

```js
import { scrape } from "mender";

const { ok, rows, healed } = await scrape("scrapers/pricing.json", { heal: true });
```

```js
rows   → [ { plan: "Starter", price: 21 }, { plan: "Pro", price: 54 }, … ]
healed → [ { target: "price", from: ".amount",
             to: '.amount, [data-testid="price-value"]', via: "heuristic" } ]
```

The site changed its markup, the scraper repaired itself mid-run, and you got real data — **but only because the repair passed every gate**. When it can't be proved, you get the failure instead of quietly wrong rows:

```js
const r = await scrape(spec, { heal: true });
r.ok        // false
r.cause     // "LAYOUT_CHANGE"
r.unhealed  // ["price"]  ← still broken, and it says so
```

| Export | Use |
| --- | --- |
| `scrape(specOrPath, opts)` | Full result: rows, cause, violations, drift, what healed. |
| `rows(specOrPath, opts)` | Just the data. Throws `MenderError` if the contract isn't satisfied. |
| `scrapeAll(dir, opts)` | Every spec in a directory, keyed by name. |
| `defineSpec(spec)` | Validates an inline spec and gives editors the type. |

Key options: `heal` (`false` \| `true` \| `"write"`), `model`, `render`, `record`, `fixtures`, `onEvent`.

## How it works

```
mender init <url> ─→ a working spec, inferred from the page

run ─→ contract check ─→ pass ─→ drift check ─→ done
            │
            └─ fail ─→ WHY? ─┬─ bot-check page     ─→ back off, selectors untouched
                             ├─ 404 / redirect     ─→ different bug, not a selector
                             ├─ missing credential ─→ config error, not a selector
                             ├─ empty response     ─→ transport, not a selector
                             └─ page fine, data wrong
                                      ↓
                            heuristics propose ─→ (empty?) ─→ model proposes
                                      ↓                            ↓
                                      └──────── 3 gates ───────────┘
                                                 │
                                        fail ────┴──── pass
                                          ↓             ↓
                                report near-misses,  open a PR
                                change nothing
```

### 1. A contract, not just a selector

```json
{
  "name": "pricing",
  "url": "https://example.com/pricing",
  "row": ".pricing-card",
  "fields": {
    "plan":     { "selector": ".plan-title", "type": "string" },
    "price":    { "selector": ".amount",     "type": "number", "min": 1 },
    "features": { "selector": "li",          "type": "list",   "minItems": 3 }
  },
  "expect": { "rows": { "min": 2, "max": 8 } }
}
```

A contract asks *is this shaped like real data*, not *did it throw*. Zero rows, an empty title, a price of `0` — all failures, all silent under a try/catch.

### 2. The cause classifier is the safety feature

Most contract failures are **not** layout changes. Rewriting selectors against a Cloudflare interstitial would teach your scraper to extract challenge text and then report itself green — worse than staying broken, because it looks fixed.

```
pricing  BLOCKED  challenge element #challenge-form
  no repair attempted: cause is BLOCKED — selectors left untouched
```

Exactly one cause — `LAYOUT_CHANGE` — may trigger a repair. `BLOCKED`, `HTTP_ERROR`, `REDIRECTED` and `EMPTY` never do, and a transport failure is marked status `0` so it can never be mistaken for a page.

### 3. Repairs are unions, not overwrites

After a real layout change the old markup is gone from the live page, and the new markup was never in your archived snapshots. **No single selector satisfies both**, so demanding one would reject every genuine fix.

```diff
- ".amount"
+ ".amount, [data-testid=\"price-value\"]"
```

The old branch keeps matching pages that used to work; the new branch matches today's. Fixtures stay a usable regression gate instead of a blocker.

### 4. Three gates

| Gate | Question | What it catches |
| --- | --- | --- |
| **live** | Does the union clear the violations it targets? | Proposals that don't work. |
| **archive** | Does it extract *byte-identical* data from every stored snapshot? | A new branch that also matches something on the old pages, shifting historical values. |
| **continuity** | Do the values still mean the same thing? | The wrong element. |

Gate three exists because the first two can both pass on a bad fix. If the price is genuinely gone and a star rating sits nearby, the rating satisfies `type: number, min: 1` today and matches nothing in the archives — so gates one and two are happy:

```
unfixed price no candidate passed every gate
  tried .rating-value  rejected at continuity  values now read as numeric,
                                               archived pages had currency,
                                               and the median moved 90% (49 to 4.8)
```

It changes nothing and tells you what it considered. **Continuity checks meaning, not formatting** — `$19` becoming `19.00` is accepted as the same value reformatted, because kind is checked first and magnitude decides when kind changes.

## The model is optional, and never in the hot path

Pointing a model at every page is slow, costs money per request, and returns slightly different answers each time. Here the hot path stays plain deterministic CSS. Heuristics handle breakage first and need no API key. **The model is consulted only when they come up empty.**

```bash
export ANTHROPIC_API_KEY=sk-...
mender repair scrapers/pricing.json --model
```

Its proposals face the identical three gates. Four properties the tests pin down:

- A page the heuristics already solved **never reaches the model** — no token spent on a solved problem.
- A `BLOCKED` page never reaches it either; the classifier stops before any proposer runs.
- A proposal the heuristics already tried isn't verified twice.
- An outage, malformed JSON, or an unparseable selector degrades to *no repair*, never to a wrong one.

## Semantic drift

If a price starts including tax, every selector matches, every type parses, all three gates pass — and the number is wrong. Structure is checked per run; **meaning can only be checked against the past.**

```
$ mender drift scrapers/pricing.json
pricing: 1 drift finding(s)
  ~ price: median 58.8 is 20% up from a baseline of 49 (MAGNITUDE_SHIFT)
```

That run had **zero contract violations**.

| Signal | Catches |
| --- | --- |
| `MAGNITUDE_SHIFT` | Tax added, currency switched, units changed. Default 15%. |
| `KIND_SHIFT` | `$19` becoming `19`, a price becoming a phrase. |
| `ROW_COUNT_SHIFT` | Silent pagination changes, a server-side filter. Default 50%. |
| `NULL_RATE_SHIFT` | A field quietly emptying out for most rows. |

Drift is **a warning for a human, never a trigger for a repair** — there's a test asserting that. Archived fixtures seed the baseline, so it works from the first run; findings from a thin baseline are labelled `provisional` rather than pretending to confidence.

## In CI

```yaml
- uses: daronthedragon/mender@main
  with:
    command: check
```

Or the full loop — check, repair, open a PR with the verified diff:

```yaml
- uses: daronthedragon/mender@main
  id: mender
  with: { command: repair, write: 'true' }
  continue-on-error: true

- uses: peter-evans/create-pull-request@v6
  if: steps.mender.outputs.status == 'repaired'
  with:
    branch: mender/selector-repair
    body-path: ${{ steps.mender.outputs.report }}
```

A ready-made scheduled workflow is in [`.github/workflows/scrape.yml`](.github/workflows/scrape.yml).

## Pagination, auth, rendering

```json
"paginate": { "next": "a.next-page", "maxPages": 10 },
"auth":     { "headerEnv": { "Authorization": "MY_API_TOKEN" } },
"render":   { "waitFor": ".pricing-card" }
```

**Pagination** follows next links (resolving relative hrefs) or numbered `urlTemplate`s. `maxPages` is required — an uncapped crawler is a bug, not a feature — and it stops at a repeated URL or the first non-200.

**Auth** names environment variables; specs never hold secrets, and config *rejects* a value that looks like a literal token. Credentials are sent on every paginated page. A missing variable is `HTTP_ERROR` naming the variable, never a layout change — rewriting selectors against a login page is exactly what this tool exists to prevent.

**Rendering** uses Playwright as an *optional peer dependency*, loaded lazily and only when a spec asks for it, so the default install stays dependency-free:

```bash
npm install playwright && npx playwright install chromium
```

Both transports run through one path, so pagination, auth, loop guards and failure semantics are identical, and a failed render is status `0` like any transport failure.

## Fixture aging

Snapshots rot; one that fails the current spec blocks every future repair.

```bash
mender fixture scrapers/pricing.json --prune
# pricing: retiring 2024-01-01 — fails the current spec and is 962 days old
```

Never retires the last passing one — a repair with no reference is what the regression gate exists to prevent — and keeps *recent* failures, since they may be a fresh break.

## CLI reference

```
mender init <url> [name]   infer a spec from a live page and archive the first fixture
mender check   [path]      run every scraper against its contract
mender extract <spec>      print the rows a spec produces, as JSON
mender fixture <spec>      archive today's page as a golden snapshot
mender repair  <spec>      diagnose, propose, verify, show the diff
mender drift   [path]      report meaning-level drift against run history

--scrapers <dir>     spec directory                (default: scrapers)
--fixtures <dir>     snapshot directory            (default: fixtures)
--html <file>        use a local file instead of fetching
--write              apply the verified fix to the spec
--only <targets>     with --write: apply only these ("row" for the row selector)
--pr-body <file>     write a pull-request body
--model              ask a model when the heuristics come up empty
--record             append this run to the history file
--render             init: load the page in a browser first
--prune              fixture: retire snapshots that stopped being useful
--max-age-days <n>   fixture --prune: age limit for failing snapshots (default 180)
--keep <n>           fixture --prune: how many snapshots to keep (default 10)
--json               machine-readable output
```

`check` and `drift` exit non-zero when anything is wrong, so cron and CI need no wrapper.

## Try every scenario offline

Each is a real file in `examples/pages/`.

```bash
node dist/cli.js repair examples/scrapers/pricing.json --fixtures examples/fixtures \
  --html examples/pages/v2-price-moved.html      # a field moved    → repaired
  --html examples/pages/v3-rows-renamed.html     # rows renamed     → repaired
  --html examples/pages/v4-price-gone-trap.html  # plausible trap   → refused
  --html examples/pages/blocked.html             # challenge page   → untouched
  --html examples/pages/v5-price-in-prose.html   # heuristics blind → needs --model
```

## What it does not do

Named honestly, because a self-healing tool that overstates itself is the worst kind.

- **Inference is a first draft.** `init` proposes types and bounds from one page; a column that happens to be numeric today may be typed `number` wrongly. Read the generated spec.
- **Drift from a thin baseline is noisy.** One fixture is enough to start judging but gives no sense of variance — hence `provisional`.
- **No JS interaction.** The browser renders and waits; it doesn't click, scroll or fill forms, so content behind a "load more" button is out of reach.
- **Continuity is per-field.** A change that keeps every field plausible alone but breaks the relationship between them — prices shifted one row up — passes everything.
- **Not on npm yet.** Install from the git URL; the package's `prepare` script builds it on install.

## Tests

395 assertions. No network beyond a server the suite starts itself, and no API key — the model path runs through an injected fake client. The browser suite adapts to whether Playwright is present rather than skipping silently.

```
$ npm test
  browser rendering                          llm proposer
  cause classification (the safety gate)     pagination and auth
  contracts and config                       public api
  continuity: reformats versus wrong         real http path
  drift cold start                           repair, end to end
  extraction                                 selector engine
  fixture retirement                         semantic drift
  html parser                                spec inference

  395 passed, 0 failed
```

MIT © Daron
