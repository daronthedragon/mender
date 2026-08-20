# mender

Scrapers don't crash when they break. They return `[]`, or `null`, or yesterday's price, and the pipeline keeps running for three weeks before anyone notices the data is garbage.

`mender` watches for that, works out **why** it happened, and only then proposes a selector fix — which it has to prove against every page that used to work before you'll ever see it.

```
run ─→ contract check ─→ pass ─→ done
              │
              └─ fail ─→ WHY? ─┬─ bot-check page  ─→ back off, selectors untouched
                               ├─ 404 / redirect  ─→ different bug, not a selector
                               ├─ empty response  ─→ transport, not a selector
                               └─ page fine, data wrong
                                        ↓
                                  propose selectors
                                        ↓
                                   3 gates ─── fail ─→ report the near-misses, change nothing
                                        │
                                       pass
                                        ↓
                                   open a PR
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
pricing  LAYOUT_CHANGE  page served normally but 3 contract violations
  fixed price
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

A proposal has to clear all three before you see it.

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

## Why the agent is not in the hot path

The obvious design points a model at the page on every run. That is slow, costs money per request, and returns slightly different answers each time — unusable at scale.

Here the hot path stays plain deterministic CSS: fast, free, reproducible. The expensive reasoning only wakes up when something breaks, which for a healthy scraper is a handful of times a year. v0.1's proposer is pure heuristics — DOM signatures, text shapes, path similarity — so **it needs no API key at all**. An LLM proposer is the next cut, and it inherits the same three gates.

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

--scrapers <dir>   spec directory                  (default: scrapers)
--fixtures <dir>   snapshot directory              (default: fixtures)
--html <file>      use a local file instead of fetching
--write            apply the verified fix to the spec
--pr-body <file>   write a pull-request body
--json             machine-readable output
```

`check` exits non-zero when anything is failing, so cron and CI need no wrapper.

## Try it without a network

Every scenario below is a real file in `examples/pages/`.

```bash
node dist/cli.js repair examples/scrapers/pricing.json --fixtures examples/fixtures \
  --html examples/pages/v2-price-moved.html      # a field moved   → repaired
```

```bash
node dist/cli.js repair examples/scrapers/pricing.json --fixtures examples/fixtures \
  --html examples/pages/v3-rows-renamed.html     # rows renamed    → repaired
```

```bash
node dist/cli.js repair examples/scrapers/pricing.json --fixtures examples/fixtures \
  --html examples/pages/v4-price-gone-trap.html  # plausible trap  → refused
```

```bash
node dist/cli.js repair examples/scrapers/pricing.json --fixtures examples/fixtures \
  --html examples/pages/blocked.html             # challenge page  → untouched
```

## What v0.1 does not do

Named honestly, because a self-healing tool that overstates itself is the worst kind.

- **No browser.** Plain `fetch` only, so client-rendered pages are out. Server-rendered pages are the majority of scraping targets and staying browserless keeps this installable in seconds.
- **No LLM proposer yet.** Heuristics only. They handle renamed classes, moved elements and new wrapper markup; they will not reason about a page that was genuinely redesigned.
- **No semantic drift detection.** If a price starts including tax, every gate passes and the number is wrong. Catching that needs distribution monitoring on values over time — the harder and more valuable half.
- **No pagination, auth, or fixture aging.** Old snapshots will eventually fail legitimately and need a retirement policy.

## Tests

165 assertions, no network required except a local server the suite starts itself.

```
$ npm test
  cause classification (the safety gate)
  contracts and config
  extraction
  real http path
  html parser
  repair, end to end
  selector engine

  165 passed, 0 failed
```

MIT.
