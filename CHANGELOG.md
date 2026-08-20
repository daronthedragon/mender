# Changelog

All notable changes to this project are documented here.
This project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

### Notes

- Published as `@daronthedragon/mender`; the unscoped name `mender` was already
  taken on npm by an unrelated package.
- Zero runtime dependencies. Playwright is an optional peer dependency, loaded
  lazily and only when a spec asks to render.
