# Changelog

All notable changes to this project are documented here.
This project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.7.2] — 2026-08-21

Found by widening the live probe to forty sites and, for the first time,
measuring the *quality* of what came out rather than only whether a spec was
produced. Twenty-six of forty yielded good data on the first pass.

### Added — carousels and modals are furniture

A homepage hero slider is repeated siblings with text, so it reads as records:
`hackaday.com` gave five promo tiles and `pkg.go.dev` gave the contents of a
modal dialog. `carousel`, `slider`, `modal` and `dialog` join the furniture
list.

Deliberately narrow. `slide` and `promo` were tried first and excluded real
article lists on sites that use those words elsewhere in a class — on one site
*every* candidate group was rejected and the page yielded nothing at all. A
rule that eats real content is worse than the carousel it was meant to skip.

### Fixed — "needs a browser" missed pages that load records by AJAX

The hint only fired on a near-empty shell, so a page with a real nav, heading
and prose whose *records* arrive by AJAX still got the useless advice. A text
length threshold was tried and immediately flagged a genuinely static page, so
the signal is now whether the page's scripts go and fetch data — `fetch(`,
`XMLHttpRequest`, `$.ajax`, `axios`, a React or Angular root:

```
scrapethissite ajax page  ->  retry with --render
a static fixture page     ->  try a listing page, or write the spec by hand
```

### Known limits this probe made explicit

- A record with a single value is not detected. `xkcd.com/archive` is a flat
  run of `<a>` separated by `<br>` with no per-record element, so there is no
  repeating structure to find.
- Some sites refuse a non-browser client outright: `stackoverflow.com`,
  `phoronix.com` and `w3.org/TR` returned HTTP 403, `imdb.com` returned 202.

752 assertions, unchanged — both fixes are covered by existing tests.

## [1.7.1] — 2026-08-21

Found by widening the live-site probe from twelve targets to twenty-four.

### Fixed — a footnote list still beat a data table

Trimming the furniture word list in 1.7.0 removed `reference`/`references`
along with the genuinely ambiguous `header`. Unlike `header`, those are never
anything else, and dropping them let a Wikipedia article pick
`.mw-references-columns li` — 132 footnotes — over the 118-row periodic table.
Restored, and the elements page now yields the table:

```
{ "column_1": 1, "column_2": "H", "column_3": "Hydrogen", …, "column_8": "1.0080" }
```

### Fixed — a bare tag was penalised like a positional selector

`tr:nth-child(1)` names a position and deserves a veto. `li` and `tr` are how
unclassed records are legitimately addressed, and penalising them equally made
an `<ol>` wrapper outscore the `<li>` items inside it. The nth-child penalty
stays; a bare tag now gets a nudge rather than a veto.

### Added — "this page needs a browser" is now said out loud

`init` on a client-rendered page advised trying a listing page, when the user
was already on one. crates.io serves 5KB containing 73 characters of text; its
records exist only after JavaScript runs. A page that is almost entirely script
now gets the useful message instead:

```
could not find a repeating record on that page
  the page is almost entirely script: its records exist only after JavaScript runs
  retry with --render  (needs: npm install playwright && npx playwright install chromium)
```

A thin page with no script at all is never blamed on JavaScript.

### Live results, 24 targets

```
hn          30  ".athing"                lobsters    25  ".story"
quotes      10  ".quote"                 books       20  ".col-xs-6"
countries  250  ".col-md-4"              hockey      25  ".team"
tables       3  ".table-bordered2 tbody tr"          ecom         3  ".col-md-4"
cities      85  ".static-row-numbers tr:nth-child(n+3)"
states     205  ".sortable tr:nth-child(n+2)"
elements   118  ".wikitable tr:nth-child(n+3)"
editors     66  ".sticky-table-head tr:nth-child(n+3)"
rustblog   400  ".post-list > tr"        goblog      11  ".blogtitle"
pydownloads  7  ".row"                   nodeblog     6  (hashed class)
danluu     200  "li"                     rfcs      9830  ".table-fixed tbody tr"
pypi         7  ".sponsors__sponsor"
```

Twenty of twenty-four produced a verified spec. Of the rest: `crates.io` and
`old.reddit.com` are client-rendered and now say so, `example.com` and an
`httpbin` link page genuinely contain no records, and `gutenberg.org` returned
HTTP 503.

752 assertions, up from 747.

## [1.7.0] — 2026-08-21

### Added — tables are inferred as tables

A table names its own fields in the header row and addresses cells by position.
Treating one as a generic record lost both: a Wikipedia list came back with a
single list field holding `["City[a]", "Country", "UN 2025 population
estimates[12]", …]` — the header row itself, captured as data.

Columns are now taken from the **data** rows, not the header. A header can span
two rows with colspan — six header cells above thirteen data columns — so
mapping header index to cell position puts every value in the wrong place. The
header is used only for naming, and only when the counts agree; otherwise the
columns are `column_N` and the data is still right.

Also handled, because real tables do all of it: a header in `<thead>` (data
rows then start at position 1 inside `<tbody>`), a leading `<th scope="row">`
so the first value is not a `<td>`, and headerless tables, which stay on the
generic path rather than treating their first row as a header.

If no selector isolates the data rows, the table path is abandoned and the
generic search runs instead — better a generic spec that passes than a
table-shaped one that does not.

### Fixed — page furniture chosen as records

A footer is repeated sibling columns with text; a nav is repeated links; a
reference list is a long run of `<li>`. Structurally these are records, and on
a Wikipedia list article the reference list is genuinely larger than the data
table, so counting alone picks the wrong one. Records in `<nav>`, `<footer>`,
`<header>`, `<aside>`, or under a navigation/contentinfo role, or in a element
whose class names it as furniture, are now excluded.

Two false positives that cost real pages, both fixed by narrowing the rule:

- `sticky-header-multi` on a Wikipedia table matched the token `header`, which
  rejected every row of the data table. Class-name matching no longer looks for
  "header" or "banner"; the `<header>` tag check covers real chrome.
- `vector-feature-language-in-main-menu` on `<html>` matched `menu`, vetoing
  every record on the page. The walk now stops at `<body>`: a class there or on
  `<html>` describes the whole document, not a region within it.

### Fixed — selectors scoped only by the immediate parent

A `<tr>` sits inside an unclassed `<tbody>`, so stopping at the parent produced
a bare `tr` matching every table on the page — 124 elements where 87 were
wanted. Selector generation now looks up to three ancestors for a named one,
yielding `.wikitable tr`. The child combinator is still offered before the
descendant form, being the tighter statement.

### Verified against live sites

```
hn          30 rows  ".athing"          lobsters   25 rows  ".story"
quotes      10 rows  ".quote"           books      20 rows  ".col-xs-6"
countries  250 rows  ".col-md-4"        hockey     25 rows  ".team"
tables       3 rows  ".table-bordered2 tbody tr"
cities      85 rows  ".static-row-numbers tr:nth-child(n+3)"
states     206 rows  ".sortable tr:nth-child(n+2)"
rustblog   400 rows  ".post-list > tr"
```

Ten of twelve targets. `example.com` correctly yields no records; gutenberg.org
returned HTTP 503 and was not reachable.

747 assertions, up from 728.

## [1.6.0] — 2026-08-21

### Fixed — inference on real pages

Found by running `mender init` against a batch of live sites rather than the
pages in this repo. Two failures, both invisible against hand-written fixtures.

**A column present in only some records became a required field.** Real
listings have optional fields, and inference already tolerated a column missing
from up to 40% of records — but it then computed `minItems` from only the
records that had it and asserted that on all of them. A generated spec came
back reporting violations against its own page. A non-universal column is now
`required: false` and carries no `minItems` it cannot meet everywhere.

**The record scorer preferred a wrapper over the records inside it.** It
rewarded "number of values contained" without a ceiling, so an outer container
holding fifty values beat the record holding five. Three changes: the density
term is capped, record count is rewarded on a log scale, and a positional row
selector is penalised — `tr:nth-child(1)` names a position, not a kind of thing.

Measured on the sites that found it:

```
                       before          after
Hacker News            4 records       30 records, row ".athing"
Wikipedia city list    3 records       126 records
scrapethissite         250 records     250 records (unchanged)
webscraper.io shop     3 records       3 records (correct — the page has 3)
```

Both shapes are kept as `examples/pages/v9-optional-and-nested.html` so the
fixes have tests that need no network, and the existing invariant — a generated
spec must produce no contract violations on the page it came from — now covers
them too.

728 assertions, up from 717.

## [1.5.1] — 2026-08-21

### Fixed — `init` could generate a spec that fails its own page

Found by pointing `mender init` at real websites rather than the pages in this
repo. On books.toscrape.com it produced a spec that immediately reported 20
contract violations against the very page it was inferred from.

Two halves had drifted apart. Inference looked at every element a selector
matched; extraction reads only the *first* match for a scalar field, and drops
empty values from a list. Real markup exposes the gap immediately:

- An `<a>` wrapping an image matches `a` first and has no text. Inference saw
  the title in a later match and typed the field a string; extraction read the
  image link and produced `null`.
- Each record matched two `<a>` elements but yielded one value, so a `minItems`
  derived from the element count asserted more than the field can ever produce.

Inference now mirrors extraction exactly: scalars are judged on the first match
per row, list bounds on non-empty values, and a selector whose first match is
usually empty is rejected as mis-aimed rather than named as a field.

### Fixed — furniture became fields

A column holding the same value in every row is a label, not data. "Add to
basket" on all twenty rows was being named as a field, inviting a contract that
asserts a button label. Constant columns are now skipped, and redundancy
suppression follows the DOM upward, so the `<a>` inside an already-claimed
`<h3>` is recognised as the same title addressed differently.

On the two real sites this was found with, `init` went from 6 fields including
3 junk ones and a failing contract, to 3 fields and `20 rows pass the generated
contract`.

### Added — an invariant instead of a hope

A generated spec must produce no contract violations on the page it came from.
That is now asserted across every bundled example page, so the two halves
cannot drift apart again unnoticed. The real-world shapes that broke it are
kept as `examples/pages/v8-realworld-shapes.html`, so the fix has a test that
needs no network.

717 assertions, up from 699.

## [1.5.0] — 2026-08-21

### Added — the data actually goes somewhere

mender kept scrapers alive and then threw away everything they scraped.
`watch` read `rows.length` for a log line and discarded the rest; `extract`
could only write to stdout. A monitor that repairs a scraper but collects
nothing has done half a job.

```json
"output": { "path": "data/{name}.jsonl", "mode": "changes", "key": "plan" }
```

- `snapshot` overwrites with the current rows, `append` adds only rows never
  seen, `changes` appends an event per new or changed record **with both**
  **values**. Formats `jsonl`, `json`, `csv`, inferred from the extension.
- Identity is by `key`, not by position, so reordered rows produce no spurious
  change events. Without a key the whole row is the identity — `doctor` warns.
- Available as `output` in a spec, `output` in settings (used by `watch`),
  `scrape({ output })`, or `mender extract --out`.

The point of the `changes` mode is continuity across a repair. When a site
redeploys, moving the price element *and* changing the prices, the history has
no gap: the move is recorded as `19 -> 21`, not as a hole where the scraper was
broken.

### Fixed — writing the output of a broken scraper

Found while testing the above. `extract --out` wrote rows regardless of whether
the contract passed, so a broken selector produced a change log full of
`price: null` recorded as though the prices had genuinely changed to nothing.

Rows are now persisted only on a run that satisfies its contract, in both the
API and the CLI. `--force` overrides it deliberately. A repaired run counts as
a good run, so its data is kept.

699 assertions, up from 631.

## [1.4.0] — 2026-08-20

### Added — politeness, the only failure this tool can prevent

`BLOCKED` is the one cause mender can never repair: when a site decides you are
a nuisance, no selector fix helps. Everything else in the project recovers from
failure. This is the only part that stops one happening.

Nothing prevented it before. A spec with `maxPages: 10` fired ten requests as
fast as the socket allowed, `watch` ran four scrapers at once against what may
be the same host, and robots.txt was never fetched at all.

- **robots.txt** is fetched once per origin, cached, parsed and obeyed:
  per-agent groups (a group naming you beats `*`), `Allow` carving exceptions
  out of a broader `Disallow` by longest match, `*` wildcards and `$` anchors,
  and consecutive `User-agent:` lines sharing the group that follows them.
- **`DISALLOWED`** is a new cause. The request is never sent — a test asserts
  the server never sees it — and like every non-layout cause it can never
  trigger a repair.
- **Per-host rate limiting shared across a run**, so concurrency stops turning
  into a burst. The slot is claimed before awaiting, so simultaneous callers
  queue instead of all reading the same free moment and firing together.
- **`Crawl-delay` is honoured** above your floor and capped by `maxDelayMs`, so
  a hostile or mistaken robots.txt cannot stall a run for ten minutes.
- An unreachable robots.txt, or one returning 5xx, is treated as **absent, not
  as a blanket ban** — a site's own outage should not take every scraper down.
- `mender doctor` reports the effective delay and names the host with the most
  scrapers sharing that queue.

The throttling claim is measured rather than configured: a test drives four
paginated requests at a real server, records arrival timestamps and asserts no
two arrived closer than the configured delay.

631 assertions, up from 587.

## [1.3.0] — 2026-08-20

### Changed — git is the install path, and npm is not involved

The package is `mender` again rather than a scope that only existed to dodge a
registry name collision, and the npm publish workflow is gone. Nothing is lost:
a tag pin, a production install and `npx` with nothing installed were all
checked and all work.

```bash
npx github:daronthedragon/mender demo             # nothing installed
npm install github:daronthedragon/mender          # as a dependency
npm install github:daronthedragon/mender#v1.3.0   # pinned to a release
```

`examples/` is now packed with the release, so a git install carries the demo.

### Added — `mender demo`

A fresh clone had nothing to point at: no scrapers, no fixtures, and a first
command that failed with `no scraper directory at scrapers`. `mender demo` runs
the real pipeline against the bundled pages with no network, no config and no
API key, through every scenario including the two where refusing is correct.

It doubles as a test. `test/demo.test.mjs` asserts each scenario still behaves
as the README claims, so a scenario that silently stops working fails the build
rather than misleading a reader.

### Added — the CLI basics that were missing

- `--version` and `-v` printed the whole manual and `unknown command` before.
- Per-command help: `mender watch --help` describes watch, not everything.
- A missing or empty scrapers directory now names the two ways forward
  (`mender init <url>`, `mender demo`) instead of just stating the error.

587 assertions, up from 567.

## [1.2.0] — 2026-08-20

### Added — the model proposer is no longer Claude-only

The repair loop only ever needed one thing from a model: text in, text out.
Keeping that interface one method wide means a provider is a request shape and
a response path rather than an integration — and it means a model running on a
laptop is a first-class option, not a downgrade.

- **anthropic**, **openai**, **gemini**, **ollama**, chosen explicitly or
  inferred from whichever API key is in the environment.
- **Any OpenAI-compatible endpoint** via `--base-url`: Groq, Together,
  OpenRouter, vLLM, LM Studio, llama.cpp. Verified end to end by repairing a
  real page through a local server with no Anthropic key present.
- **Ollama needs no key at all**, so nothing has to leave the machine.
- Config, flags (`--provider`, `--model-name`, `--base-url`) or environment
  (`MENDER_PROVIDER`, `MENDER_MODEL`, `MENDER_BASE_URL`). Keys are still named
  variables, never values in a config file.

### Added — robustness in the model path

- Retries with exponential backoff on 429 and 5xx, honouring `Retry-After`.
  A 400 or 401 fails immediately, because retrying cannot help.
- Per-request timeouts, and transport failures surfaced as `ProviderError`.
- The Gemini key travels in a header rather than the query string, so it never
  lands in a proxy log or in an error message containing the URL.
- `mender doctor` reports the resolved provider and model, and names the exact
  variable to export when a key is missing.

`anthropicClient()` still works and now delegates to the provider layer, so it
gains the retries too. Its `name` is now `anthropic:<model>` rather than bare
`<model>` — the only visible break, and it appears in repair output as
`fixed price via anthropic:claude-sonnet-5`.

567 assertions, up from 502.

## [1.1.0] — 2026-08-20

### Fixed — a repair could silently drop half your data

The three verification gates all ask whether a *value* is right. None of them
asked whether the *records were carved up right*, and that gap was exploitable
by an entirely ordinary layout change.

A page that regroups its records — cards that were siblings now sitting two to
a wrapper — let a repair land on the wrapper. That candidate passed every gate:
the contract was satisfied (a plausible row count, the right kind of values),
the archive was byte-identical because the new selector does not exist there,
and continuity was happy because the values it captured really were currency.

The result, on a four-record page, was accepted silently:

```
  data : [{"plan":"Starter","price":19},{"plan":"Scale","price":199}]
  truth: Starter 19, Pro 49, Scale 199, Enterprise 499
```

Two records vanished and the survivors kept only the first plan in each pair.
This is precisely the silently-wrong-data failure the whole project exists to
prevent, and it was reachable from a normal site redesign.

### Added — a fourth gate: coverage

Coverage compares the fraction of a field's elements the row structure actually
reaches against the fraction the archive reached. It needs no knowledge of what
the correct grouping is — the document still contains the elements, the rows
just stopped reaching them:

```
tried .pair  rejected at coverage  the rows reach only 2 of 4 plan element(s) on
                                   the page (50%, archives reached 100%) -
                                   2 record(s) would be silently dropped
```

Rejecting the wrong grouping also keeps the search alive: on the same page the
repairer goes on to find `.pair > article` and recovers all four records with
each price attached to its own plan.

Legitimate repairs are unaffected — moved fields, renamed row containers and
unchanged pages all still pass, with tests asserting each.

502 assertions, up from 484.
## [1.0.0] — 2026-08-20

First stable release. The API surface below is what 1.x will keep.

### Added — diagnostics

- **`mender doctor`** — static checks over a project's setup, with the fix
  command attached to every finding. Two of them silently disable repair and are
  therefore errors, not warnings: no fixtures at all, and every fixture stale —
  in both cases a repair has no known-good reference and refuses to run. Also
  checks auth and notification environment variables, Playwright presence for
  specs that ask to render, and whether the drift baseline is deep enough to
  judge. Makes no network requests, so it is safe in a deploy script.

### Added — supervision

- **`mender watch`** — a supervisor that runs every scraper on a cycle, repairs
  what it can, and reports what it cannot. `--once` for an existing cron,
  `--interval 15m` to run standalone, `--concurrency` to bound parallelism.
- **Transition-based notifications.** The same break is reported once, not every
  cycle. State is keyed on the *condition* (cause plus which targets are
  broken), so a second field breaking is a new incident but an unchanged one
  stays quiet. A monitor that cries every fifteen minutes gets muted, and a
  muted monitor protects nothing.
- **Channels**: Slack, Discord, generic webhook, append-only JSONL, console.
  Webhook URLs are named environment variables, never values in the config, so
  a settings file stays safe to commit. A channel that is down is reported and
  skipped rather than taking the run with it.
- **Backoff.** A blocked target is skipped for a growing number of cycles
  instead of being hammered; a persistently failing one backs off more slowly.
- **`mender.config.json`** — scrapers, fixtures, heal mode, interval,
  concurrency, drift thresholds and notification channels in one committed
  file. Explicit flags still win over it.

### Added — earlier in the 0.x line

- **`mender init <url>`** infers a working spec from a live page: finds the
  repeating record, proposes fields, infers types, names them from the markup,
  and proves the result passes before claiming it.
- **Library API** — `scrape()`, `rows()`, `scrapeAll()`, `defineSpec()`.
  `heal: true` repairs mid-run and returns real data; `heal: "write"` persists.
- **Model proposer**, consulted only when the heuristics come up empty, and
  facing the identical three verification gates.
- **Semantic drift detection** — magnitude, kind, row count and null rate against
  run history, seeded from archived fixtures so it works on the first run.
- **Browser rendering** via Playwright as an optional peer dependency.
- **Pagination**, **auth** by named environment variable, **fixture retirement**.

### Performance

Measured with `bench/bench.mjs` against a 270 KiB synthetic page (7,292
elements) and the real example pages. Medians of three runs.

- `runRepair` over a 200-row page: **610 ms → 62 ms (9.9x)**
- `propose()` over 200 rows: **103 ms → 3.1 ms (33x)**
- `querySelectorAll` by class: **0.65 ms → 0.010 ms (65x)**
- Parsing 270 KiB: **4.90 ms → 2.38 ms (2.1x)**
- `runCheck` on a large page: **20.9 ms → 8.6 ms (2.4x)**

From a candidate-narrowing index in the selector engine, per-node caches for
descendants/children/text (the tree is immutable after `parse()`), O(1) sibling
positions recorded at parse time, and hoisting exemplar-derived invariants out
of the repair scoring loop — the last being the single largest win.

The narrowing index assumes an element matching a compound carries that
compound's class, tag, id or attribute name. `test/equivalence.test.mjs` guards
it permanently with ~9,000 comparisons against an unnarrowed oracle, because a
future selector feature that broke the assumption would fail silently.

### Fixed

- `watch` passed the loaded spec object to `scrape`, so `heal: "write"` could
  never persist a repair. It now passes the spec path, which also means a repair
  written on one cycle is picked up on the next.
- A spec directory containing `package-lock.json` crashed the whole run with a
  message about a missing `"url"`. Files that do not claim to be specs are now
  skipped; ones that do and are malformed still fail loudly.
- `EMPTY` was classified from text length and element count alone, so a dense
  client-rendered listing that had just yielded valid rows was labelled empty.
  Row count now gates it.
- Continuity rejected legitimate reformats (`$19` → `19.00`). Kind is checked
  first; when kind changes, magnitude decides.
- The CSS selector parser swallowed `:` into tag names, so `p:nth-child(3)`
  never parsed.
- Whitespace after `>`, `+` or `~` overwrote the combinator, silently
  downgrading every one of them to a descendant combinator.
- Transport failures classified as `EMPTY` rather than `HTTP_ERROR`; they are
  now marked status `0` and can never be mistaken for a repairable page.
- The raw-text close matcher was built as `` `</${tag}\s*>` `` in a template
  literal, where `\s` is not an escape sequence and collapses to a plain "s".
  It therefore failed on the entirely legal `</script >` — swallowing the rest
  of the document as script text — while wrongly matching `</scriptsss>`.

### Notes

- Published as `@daronthedragon/mender`; the unscoped name `mender` was already
  taken on npm by an unrelated package.
- Zero runtime dependencies. Playwright is an optional peer dependency, loaded
  lazily and only when a spec asks to render.
