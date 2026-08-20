# mender

Scrapers don't crash when they break. They return `[]`, or `null`, or yesterday's price, and the pipeline keeps running for three weeks before anyone notices the data is garbage.

`mender` watches for that, works out **why** it happened, and only then proposes a selector fix — which it has to prove against every page that used to work before you'll ever see it.

```
run ─→ contract check ─→ pass ─→ drift check ─→ done
              │
              └─ fail ─→ WHY? ─┬─ bot-check page  ─→ back off, selectors untouched
                               ├─ 404 / redirect  ─→ different bug, not a selector
                               ├─ missing credential ─→ config error, not a selector
                               ├─ empty response  ─→ transport, not a selector
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

Zero runtime dependencies. Own HTML parser, own CSS selector engine, plain `fetch`.

## The loop

**1. Declare a contract, not just a selector.**

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

**2. Archive a snapshot while it still works.**

```bash
mender fixture scrapers/pricing.json
```

Refuses unless the contract currently passes. A fixture is only worth keeping as a known-good reference.

**3. Run it. When it breaks, ask why before touching anything.**

```
$ mender check scrapers/pricing.json
pricing  LAYOUT_CHANGE  page served normally but 3 contract violations
  https://example.com/pricing  200 · 0ms · 3 rows
  x price[row 0]: selector ".amount" matched nothing
  x price[row 1]: selector ".amount" matched nothing
  x price[row 2]: selector ".amount" matched nothing

1/1 scraper(s) failing
```

**4. Repair — with receipts.**

```
$ mender repair scrapers/pricing.json
  fixed price via heuristic
    - ".amount"
    + ".amount, [data-testid=\"price-value\"]"
      ok live         3 rows pass for price
      ok 2026-07-02   3 rows unchanged
      ok continuity   values still read as currency
```

`--write` applies it, `--pr-body out.md` writes the pull request.

## Why it's a union selector

After a real layout change the old markup is gone from the live page, and the new markup was never in your archived snapshots. **No single selector can satisfy both**, so demanding one would reject every genuine fix.

Unions solve it. The old branch keeps matching the pages that used to work; the new branch matches today's. Your fixtures stay a usable regression gate instead of a blocker, and selectors accumulate history rather than losing it.

## The three gates

A proposal has to clear all three before you see it — whoever proposed it.

| Gate | Question | What it catches |
| --- | --- | --- |
| **live** | Does the union clear the violations it targets? | Proposals that simply don't work. |
| **archive** | Does it extract *byte-identical* data from every stored snapshot? | A new branch that also matches something on the old pages, quietly shifting historical values. |
| **continuity** | Do the values still read as the same *kind* of thing? | The wrong element. `$19 → $19.00` passes; `$19 → 4.8` does not. |

Gate three exists because gates one and two can both pass on a bad fix. If the price is genuinely gone and a star rating sits nearby, the rating satisfies `type: number, min: 1` on the live page and matches nothing on the archives — so the first two gates are happy. Only asking "is this still a price" catches it:

```
$ mender repair scrapers/pricing.json      # price replaced by "Talk to sales"
  unfixed price no candidate passed every gate
    tried .rating-value    rejected at continuity  values now read as numeric, archived pages had currency
    tried p.rating-value   rejected at continuity  values now read as numeric, archived pages had currency
    tried p:nth-child(3)   rejected at continuity  values now read as numeric, archived pages had currency
  4 candidate(s) rejected by verification
```

It changes nothing and tells you what it considered. That is the correct outcome.

## The cause classifier is the safety feature

Most contract failures are **not** layout changes. Rewriting selectors against a Cloudflare interstitial would teach your scraper to extract challenge text and then report itself green — worse than staying broken, because it looks fixed.

```
$ mender repair scrapers/pricing.json
pricing  BLOCKED  challenge element #challenge-form
  no repair attempted: cause is BLOCKED (challenge element #challenge-form) — selectors left untouched
```

Exactly one cause — `LAYOUT_CHANGE` — is allowed to trigger a repair. `BLOCKED`, `HTTP_ERROR`, `REDIRECTED` and `EMPTY` never are, and a transport failure is marked status `0` so it can never be mistaken for a page.

## The model is not in the hot path

The obvious design points a model at the page on every run. That is slow, costs money per request, and returns slightly different answers each time — unusable at scale.

Here the hot path stays plain deterministic CSS: fast, free, reproducible. Heuristics — DOM signatures, text shapes, path similarity — handle breakage first and need no API key at all. **The model is only consulted when the heuristics come up empty**, which for a healthy scraper is a handful of times a year.

```bash
export ANTHROPIC_API_KEY=sk-...
mender repair scrapers/pricing.json --model
```

The model earns nothing by being a model. Its proposals face the identical three gates:

```
  fixed price via claude-sonnet-5
    - ".amount"
    + ".amount, .blurb"
      ok live         3 rows pass for price
      ok 2026-07-02   3 rows unchanged
      ok continuity   values still read as currency
```

And when it is wrong, it is refused exactly like a heuristic:

```
  unfixed price no candidate passed every gate
    tried [class="rating-value"]  (claude-sonnet-5)  rejected at continuity  values now read as numeric, archived pages had currency
```

Four properties the tests pin down:

- A page the heuristics already solved **never reaches the model** — no token is spent on a solved problem.
- A `BLOCKED` page never reaches the model either, because the cause classifier stops before any proposer runs.
- A proposal the heuristics already tried is not verified twice.
- A model outage, malformed JSON, or an unparseable selector degrades to *no repair*, never to a wrong one.

The model is told that returning an empty list is a valid answer, and an empty list is honoured rather than second-guessed.

## Semantic drift: the failure the contract cannot see

If a price starts including tax, every selector still matches, every type still parses, all three gates pass — and the number is wrong. Structure is checked per run; **meaning can only be checked against the past**.

```bash
mender check scrapers/pricing.json --record   # build a baseline
mender drift scrapers/pricing.json            # compare against it
```

```
pricing: 1 drift finding(s)
  ~ price: median 58.8 is 20% up from a baseline of 49 (MAGNITUDE_SHIFT)
```

That run had **zero contract violations**. Four signals are tracked against run history:

| Signal | Catches |
| --- | --- |
| `MAGNITUDE_SHIFT` | Tax added, currency switched, units changed. Default threshold 15%. |
| `KIND_SHIFT` | `$19` becoming `19`, a price becoming a phrase. |
| `ROW_COUNT_SHIFT` | Silent pagination changes, a filter applied server-side. Default 50%. |
| `NULL_RATE_SHIFT` | A field quietly emptying out for most rows. |

Drift is **a warning for a human, never a trigger for a repair**. Rewriting a selector because a price started including tax would be exactly the wrong move, and there is a test asserting it does not happen.

Drift is judged only on a structurally sound run — a broken selector would otherwise report itself as a dramatic change in meaning.

## Pagination

```json
"paginate": { "next": "a.next-page", "maxPages": 10 }
```

Follows next links, resolving relative hrefs, accumulating rows across pages. Or address pages directly:

```json
"paginate": { "urlTemplate": "https://example.com/list?page={page}", "maxPages": 10 }
```

`maxPages` is required — an uncapped crawler is a bug, not a feature. It also stops at a repeated URL, so a page linking to itself cannot spin forever, and at the first non-200.

## Auth

Specs name environment variables. **They never hold secrets**, so a spec file stays safe to commit — config validation rejects a value that looks like a literal token rather than a variable name.

```json
"auth": {
  "headerEnv": { "Authorization": "MY_API_TOKEN" },
  "cookieEnv": "MY_SESSION_COOKIE",
  "basicEnv": { "user": "SITE_USER", "pass": "SITE_PASS" }
}
```

Credentials are sent on every paginated page, not just the first. A missing variable is reported as `HTTP_ERROR` naming the variable — never as a layout change, because rewriting selectors against a login page is precisely the failure this tool exists to prevent.

## Fixture aging

Snapshots rot. One from eighteen months ago will eventually fail the current spec for legitimate reasons, and once it does it blocks every future repair.

```bash
mender fixture scrapers/pricing.json --prune
```

```
pricing: retiring 2024-01-01 — fails the current spec and is 962 days old
```

The policy retires snapshots that have stopped being a useful reference, and **never the last passing one** — a repair with no reference is what the regression gate exists to prevent. A *recent* failing snapshot is kept, since it may just be a fresh break you haven't fixed yet.

## Install

```bash
git clone https://github.com/daronthedragon/mender && cd mender && npm install && npm run build
```

```bash
npm test
```

## Commands

```
mender check   [path]   run every scraper (or one spec) against its contract
mender extract <spec>   print the rows a spec currently produces, as JSON
mender fixture <spec>   archive today's page as a golden snapshot
mender repair  <spec>   diagnose, propose, verify, show the diff
mender drift   [path]   report meaning-level drift against run history

--scrapers <dir>     spec directory                (default: scrapers)
--fixtures <dir>     snapshot directory            (default: fixtures)
--html <file>        use a local file instead of fetching
--write              apply the verified fix to the spec
--pr-body <file>     write a pull-request body
--model              ask a model when the heuristics come up empty
--record             append this run to the history file
--prune              fixture: retire snapshots that stopped being useful
--max-age-days <n>   fixture --prune: age limit for failing snapshots (default 180)
--keep <n>           fixture --prune: how many snapshots to keep (default 10)
--json               machine-readable output
```

`check` and `drift` exit non-zero when anything is wrong, so cron and CI need no wrapper.

## Try it without a network

Every scenario below is a real file in `examples/pages/`.

```bash
node dist/cli.js repair examples/scrapers/pricing.json --fixtures examples/fixtures \
  --html examples/pages/v2-price-moved.html      # a field moved    → repaired
```

```bash
node dist/cli.js repair examples/scrapers/pricing.json --fixtures examples/fixtures \
  --html examples/pages/v3-rows-renamed.html     # rows renamed     → repaired
```

```bash
node dist/cli.js repair examples/scrapers/pricing.json --fixtures examples/fixtures \
  --html examples/pages/v4-price-gone-trap.html  # plausible trap   → refused
```

```bash
node dist/cli.js repair examples/scrapers/pricing.json --fixtures examples/fixtures \
  --html examples/pages/blocked.html             # challenge page   → untouched
```

```bash
node dist/cli.js repair examples/scrapers/pricing.json --fixtures examples/fixtures \
  --html examples/pages/v5-price-in-prose.html   # heuristics blind → needs --model
```

## What it still does not do

Named honestly, because a self-healing tool that overstates itself is the worst kind.

- **No browser.** Plain `fetch` only, so client-rendered pages are out. Adding one means a real runtime dependency, which is the one property this project hasn't spent yet.
- **Continuity can false-reject a legitimate reformat.** If a price changes from `$19` to `19 dollars` the kind changes and a correct repair is refused. Refusing costs you a manual fix; accepting a wrong one costs you a database of bad data, so the gate errs the expensive-but-safe way.
- **Drift needs history.** Three prior runs minimum, so a brand-new scraper is blind until it has a baseline.
- **`--write` on a multi-target repair is all-or-nothing.** No way to accept the row fix and reject the field fix from the CLI.

## Tests

286 assertions. No network required beyond a local server the suite starts itself, and no API key — the model path is tested through an injected fake client.

```
$ npm test
  cause classification (the safety gate)
  contracts and config
  semantic drift
  fixture retirement
  extraction
  real http path
  html parser
  llm proposer
  pagination and auth
  repair, end to end
  selector engine

  286 passed, 0 failed
```

MIT.
