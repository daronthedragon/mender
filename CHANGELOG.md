# Changelog

All notable changes to this project are documented here.
This project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
