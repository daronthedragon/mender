import { eq, ok, section } from "./harness.mjs";
import { mkdtempSync, rmSync, writeFileSync, copyFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runCycle,
  watch,
  conditionOf,
  eventFor,
  cooldownFor,
  loadState,
  summariseCycle,
} from "../dist/watch.js";
import { dispatch, notifiersFrom, renderText, shouldSend, NotifyConfigError, ALL_EVENTS } from "../dist/notify.js";
import { parseDuration, formatDuration, loadSettings, SettingsError } from "../dist/settings.js";

section("durations and settings");

eq(parseDuration("30s"), 30, "seconds");
eq(parseDuration("15m"), 900, "minutes");
eq(parseDuration("2h"), 7200, "hours");
eq(parseDuration("1d"), 86400, "days");
eq(parseDuration("45"), 45, "a bare number is seconds");
eq(parseDuration(120), 120, "a number passes through");
eq(formatDuration(900), "15m", "formats back");
eq(formatDuration(45), "45s", "short durations stay in seconds");
eq(formatDuration(5400), "1.5h", "and long ones read as hours");

{
  let threw = false;
  try {
    parseDuration("soon");
  } catch (e) {
    threw = e instanceof SettingsError;
  }
  ok(threw, "an unreadable duration raises rather than defaulting silently");
}

{
  const dir = mkdtempSync(join(tmpdir(), "mender-cfg-"));
  const file = join(dir, "mender.config.json");
  writeFileSync(file, JSON.stringify({ interval: 60, heal: "write", concurrency: 2 }));
  const s = loadSettings(file);
  eq(s.interval, 60, "settings load");
  eq(s.heal, "write", "including heal mode");

  writeFileSync(file, JSON.stringify({ interval: 1 }));
  let threw = false;
  try {
    loadSettings(file);
  } catch (e) {
    threw = e instanceof SettingsError;
  }
  ok(threw, "an interval below the floor is rejected, not silently clamped");

  writeFileSync(file, JSON.stringify({ heal: "sometimes" }));
  threw = false;
  try {
    loadSettings(file);
  } catch (e) {
    threw = e instanceof SettingsError;
  }
  ok(threw, "an invalid heal mode is rejected");
  rmSync(dir, { recursive: true, force: true });
}

section("notification channels");

const note = {
  event: "repaired",
  scraper: "pricing",
  url: "https://example.com/pricing",
  ts: "2026-08-20T00:00:00Z",
  cause: "LAYOUT_CHANGE",
  detail: "1 selector repaired",
  fixes: [{ target: "price", from: ".amount", to: ".amount, .price", via: "heuristic" }],
};

{
  const text = renderText(note);
  ok(text.includes("pricing repaired itself"), "the headline says what happened");
  ok(text.includes(".amount, .price"), "and the text carries the diff");
}

eq(shouldSend(undefined, "broken"), true, "broken is on by default");
eq(shouldSend(undefined, "drift"), false, "drift is off by default, being advisory");
eq(shouldSend({ on: ["drift"] }, "drift"), true, "and can be turned on");
eq(shouldSend({ on: ["drift"] }, "broken"), false, "an explicit list is exhaustive");
eq(ALL_EVENTS.length, 6, "six event kinds");

{
  // Secrets come from the environment, never the config file.
  const env = { HOOK: "https://hooks.example.com/abc" };
  const built = notifiersFrom({ slack: { webhookEnv: "HOOK" }, file: { path: "x.jsonl" } }, env);
  eq(built.map((n) => n.name).join(","), "slack,file:x.jsonl", "channels build from config");

  let threw = null;
  try {
    notifiersFrom({ slack: { webhookEnv: "ABSENT" } }, env);
  } catch (e) {
    threw = e;
  }
  ok(threw instanceof NotifyConfigError, "a missing webhook variable is named, not ignored");
  ok(threw.message.includes("ABSENT"), "and the variable is in the message");
}

{
  // One dead channel must not take the run — or the other channels — with it.
  const sent = [];
  const good = { name: "good", async send(n) { sent.push(n.scraper); } };
  const bad = { name: "bad", async send() { throw new Error("503 from slack"); } };
  const result = await dispatch([bad, good, bad], note);
  eq(result.sent.join(), "good", "the healthy channel still delivered");
  eq(result.failed.length, 2, "and the failures are reported");
  ok(result.failed[0].error.includes("503"), "with their reasons");
}

section("watch state machine");

const result = (over = {}) => ({
  ok: true,
  rows: [{ a: 1 }, { a: 2 }],
  cause: "OK",
  causeDetail: "contract satisfied",
  violations: [],
  drift: [],
  healed: [],
  unhealed: [],
  spec: { name: "pricing", url: "https://example.com/pricing", fields: {} },
  pages: 1,
  ...over,
});

const broken = result({ ok: false, cause: "LAYOUT_CHANGE", causeDetail: "3 violations", unhealed: ["price"], rows: [] });
const repaired = result({ healed: [{ target: "price", from: ".a", to: ".a, .b", via: "heuristic" }] });
const blocked = result({ ok: false, cause: "BLOCKED", causeDetail: "challenge element", unhealed: [], rows: [] });

eq(conditionOf(result()), "ok", "a healthy run is condition ok");
eq(conditionOf(broken), "LAYOUT_CHANGE:price", "a break is keyed by cause and target");
eq(conditionOf(result({ ok: false, cause: "LAYOUT_CHANGE", unhealed: ["price", "plan"] })),
   "LAYOUT_CHANGE:plan,price", "multiple targets are sorted, so the key is stable");
eq(conditionOf(result({ drift: [{ field: "price", code: "MAGNITUDE_SHIFT", detail: "x" }] })),
   "drift:price/MAGNITUDE_SHIFT", "drift on a passing run has its own condition");

eq(eventFor(repaired, undefined), "repaired", "a healed run reports repaired");
eq(eventFor(broken, undefined), "unrepaired", "a break with unhealed targets reports unrepaired");
eq(eventFor(blocked, undefined), "blocked", "a blocked run has its own event");
eq(eventFor(result(), undefined), null, "a healthy run with no history is not an event");
eq(eventFor(result(), { condition: "LAYOUT_CHANGE:price" }), "recovered", "healthy after broken is a recovery");
eq(eventFor(result(), { condition: "ok" }), null, "healthy after healthy is silence");

eq(cooldownFor(1, "BLOCKED"), 2, "a blocked target backs off immediately");
eq(cooldownFor(3, "BLOCKED"), 8, "and the backoff grows");
eq(cooldownFor(9, "BLOCKED"), 8, "up to a ceiling");
eq(cooldownFor(1, "LAYOUT_CHANGE"), 0, "an ordinary break does not back off at first");
eq(cooldownFor(5, "LAYOUT_CHANGE"), 2, "but a persistent one eventually does");

/* ---- cycles over a real spec directory, with an injected scraper ---- */
function harness(sequence) {
  const dir = mkdtempSync(join(tmpdir(), "mender-watch-"));
  copyFileSync("examples/scrapers/pricing.json", join(dir, "pricing.json"));
  const sent = [];
  const notifier = { name: "test", async send(n) { sent.push(n); } };
  let call = 0;
  const scraper = async () => sequence[Math.min(call++, sequence.length - 1)];
  return {
    dir,
    sent,
    cycle: (extra = {}) =>
      runCycle({
        settings: { scrapers: dir, fixtures: dir, concurrency: 2 },
        notifiers: [notifier],
        statePath: join(dir, "state.json"),
        scraper,
        ...extra,
      }),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

{
  // The property that decides whether this is usable: the same break must not
  // be reported on every cycle.
  const h = harness([broken, broken, broken]);
  const first = await h.cycle();
  eq(first.broken, 1, "cycle one sees the break");
  eq(h.sent.length, 1, "and reports it once");
  eq(h.sent[0].event, "unrepaired", "with the right event");

  await h.cycle();
  await h.cycle();
  eq(h.sent.length, 1, "the same break is not reported again on later cycles");
  h.cleanup();
}

{
  // A changed condition is a new incident and does get through.
  const worse = result({ ok: false, cause: "LAYOUT_CHANGE", unhealed: ["price", "plan"], rows: [] });
  const h = harness([broken, worse]);
  await h.cycle();
  await h.cycle();
  eq(h.sent.length, 2, "a second field breaking is reported as a new incident");
  h.cleanup();
}

{
  // Recovery closes the loop.
  const h = harness([broken, result()]);
  await h.cycle();
  await h.cycle();
  eq(h.sent.map((n) => n.event).join(">"), "unrepaired>recovered", "broken then healthy reports a recovery");
  h.cleanup();
}

{
  const h = harness([repaired, result()]);
  const r = await h.cycle();
  eq(r.repaired, 1, "a healed run is counted as repaired");
  eq(h.sent[0].event, "repaired", "and reported");
  eq(h.sent[0].fixes[0].to, ".a, .b", "with the diff attached");
  h.cleanup();
}

{
  // --notify-always overrides the transition rule for people who want a pulse.
  const h = harness([broken, broken]);
  await h.cycle({ alwaysNotify: true });
  await h.cycle({ alwaysNotify: true });
  eq(h.sent.length, 2, "notify-always sends every cycle");
  h.cleanup();
}

{
  // Backoff: a blocked target is skipped on the next cycles rather than hammered.
  const h = harness([blocked, blocked, blocked, blocked]);
  const c1 = await h.cycle();
  eq(c1.entries[0].skipped, false, "cycle one runs");
  const c2 = await h.cycle();
  eq(c2.entries[0].skipped, true, "cycle two is skipped while cooling down");
  const state = loadState(join(h.dir, "state.json"));
  ok(state.pricing.cooldown >= 0, "cooldown is tracked in state");
  h.cleanup();
}

{
  // A scraper that throws must not take the cycle down.
  const dir = mkdtempSync(join(tmpdir(), "mender-throw-"));
  copyFileSync("examples/scrapers/pricing.json", join(dir, "pricing.json"));
  const report = await runCycle({
    settings: { scrapers: dir, fixtures: dir },
    notifiers: [],
    statePath: join(dir, "state.json"),
    scraper: async () => {
      throw new Error("network on fire");
    },
  });
  eq(report.entries[0].condition, "ERROR", "the failure is recorded");
  ok(existsSync(join(dir, "state.json")), "and state is still written");
  const state = loadState(join(dir, "state.json"));
  ok(state.pricing.condition.includes("network on fire"), "with the reason kept");
  rmSync(dir, { recursive: true, force: true });
}

{
  // A corrupt state file is survivable.
  const dir = mkdtempSync(join(tmpdir(), "mender-corrupt-"));
  writeFileSync(join(dir, "state.json"), "{ not json");
  eq(Object.keys(loadState(join(dir, "state.json"))).length, 0, "a corrupt state file reads as empty");
  rmSync(dir, { recursive: true, force: true });
}

{
  // The loop itself, with time and the scraper both stubbed.
  const h = harness([broken, result()]);
  const slept = [];
  const reports = await watch({
    settings: { scrapers: h.dir, fixtures: h.dir, interval: 900 },
    notifiers: [],
    statePath: join(h.dir, "state.json"),
    scraper: async () => result(),
    maxCycles: 3,
    sleep: async (ms) => slept.push(ms),
  });
  eq(reports.length, 3, "it runs the requested number of cycles");
  eq(slept.length, 2, "sleeping between cycles but not after the last");
  eq(slept[0], 900000, "for the configured interval");
  h.cleanup();
}

eq(
  summariseCycle({ entries: [], ok: 3, broken: 1, repaired: 2, notificationsSent: 0, notificationFailures: [], ts: "" }),
  "3 ok, 2 repaired, 1 broken",
  "the summary line reads plainly",
);
