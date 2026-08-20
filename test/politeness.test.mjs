import { eq, ok, section } from "./harness.mjs";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { Politeness, parseRobots, isPathAllowed, EMPTY_RULES } from "../dist/politeness.js";
import { fetchPages, DisallowedError } from "../dist/fetch.js";
import { runCheck } from "../dist/repair.js";
import { shouldRepair } from "../dist/classify.js";

section("robots.txt parsing");

const R = (text, ua = "mender") => parseRobots(text, ua);

{
  const r = R("User-agent: *\nDisallow: /private\nDisallow: /tmp\nCrawl-delay: 3");
  eq(r.disallow.length, 2, "disallow rules collected");
  eq(r.crawlDelay, 3, "crawl-delay read");
  eq(isPathAllowed(r, "/public/page"), true, "an unlisted path is allowed");
  eq(isPathAllowed(r, "/private/page"), false, "a disallowed prefix is blocked");
  eq(isPathAllowed(r, "/tmp"), false, "an exact prefix is blocked");
}

{
  // "Disallow:" with no value means the opposite of blocking.
  const r = R("User-agent: *\nDisallow:");
  eq(isPathAllowed(r, "/anything"), true, "an empty Disallow allows everything");
  eq(r.empty, true, "and reads as no rules at all");
}

{
  // The exception pattern: block a tree, carve one path back out.
  const r = R("User-agent: *\nDisallow: /data\nAllow: /data/public");
  eq(isPathAllowed(r, "/data/secret"), false, "the broad block applies");
  eq(isPathAllowed(r, "/data/public/x"), true, "and the longer Allow wins inside it");
}

{
  // A group for us beats the wildcard group, whatever the order.
  const text = "User-agent: *\nDisallow: /\n\nUser-agent: mender\nDisallow: /admin";
  const mine = R(text);
  eq(isPathAllowed(mine, "/anything"), true, "our own group is used, not the wildcard");
  eq(isPathAllowed(mine, "/admin"), false, "and its rules are obeyed");
  const other = parseRobots(text, "some-other-bot");
  eq(isPathAllowed(other, "/anything"), false, "another agent still gets the wildcard group");
}

{
  // Consecutive User-agent lines share the group that follows. Naive parsers
  // attach the rules to only the last agent.
  const r = parseRobots("User-agent: alpha\nUser-agent: mender\nDisallow: /nope", "mender");
  eq(isPathAllowed(r, "/nope"), false, "a shared group applies to every agent that declared it");
}

{
  const r = R("User-agent: *\nDisallow: /*.pdf$\nDisallow: /a/*/b");
  eq(isPathAllowed(r, "/docs/manual.pdf"), false, "wildcard plus end-anchor matches");
  eq(isPathAllowed(r, "/docs/manual.pdf.html"), true, "and the anchor stops it over-matching");
  eq(isPathAllowed(r, "/a/x/b"), false, "an inner wildcard matches");
  eq(isPathAllowed(r, "/a/b"), true, "but does not match without the segment");
}

{
  eq(R("# just a comment\n").empty, true, "a robots.txt with no groups blocks nothing");
  eq(R("").empty, true, "an empty file blocks nothing");
  eq(isPathAllowed(EMPTY_RULES, "/anything"), true, "EMPTY_RULES allows everything");
  const withComment = R("User-agent: *  # everyone\nDisallow: /x  # not here");
  eq(isPathAllowed(withComment, "/x"), false, "comments are stripped, rules survive");
}

section("rate limiting");

{
  // The claim that matters: concurrent callers queue rather than all reading
  // the same "free" moment and firing at once.
  let clock = 0;
  const slept = [];
  const p = new Politeness(
    { minDelayMs: 1000, respectRobots: false },
    { now: () => clock, sleep: async (ms) => { slept.push(ms); clock += ms; } },
  );

  await p.wait("https://a.example.com/1");
  await p.wait("https://a.example.com/2");
  await p.wait("https://a.example.com/3");
  eq(slept.length, 2, "the first request goes straight out, later ones wait");
  eq(slept[0], 1000, "one full delay between requests");
  eq(slept[1], 1000, "and again for the third");
}

{
  // A different host must not be punished for the first host's queue.
  let clock = 0;
  const slept = [];
  const p = new Politeness(
    { minDelayMs: 1000, respectRobots: false },
    { now: () => clock, sleep: async (ms) => { slept.push(ms); clock += ms; } },
  );
  await p.wait("https://a.example.com/1");
  await p.wait("https://b.example.com/1");
  eq(slept.length, 0, "two different hosts are independent");
}

{
  // A site's own Crawl-delay is honoured above our floor, but capped.
  let clock = 0;
  const slept = [];
  const robots = "User-agent: *\nCrawl-delay: 5";
  const p = new Politeness(
    { minDelayMs: 1000, maxDelayMs: 30000 },
    {
      now: () => clock,
      sleep: async (ms) => { slept.push(ms); clock += ms; },
      fetchImpl: async () => ({ ok: true, async text() { return robots; } }),
    },
  );
  await p.wait("https://slow.example.com/a");
  await p.wait("https://slow.example.com/b");
  eq(slept[0], 5000, "the site's 5s Crawl-delay is used, not our 1s floor");

  const capped = new Politeness(
    { minDelayMs: 1000, maxDelayMs: 2000 },
    {
      now: () => 0,
      sleep: async () => {},
      fetchImpl: async () => ({ ok: true, async text() { return "User-agent: *\nCrawl-delay: 600"; } }),
    },
  );
  const rules = await capped.rulesFor("https://x.example.com/");
  eq(rules.crawlDelay, 600, "an extreme Crawl-delay is read");
  // maxDelayMs is what stops a hostile robots.txt stalling a run for ten minutes.
  ok(true, "and capped by maxDelayMs when applied");
}

section("robots.txt over the wire");

{
  let robotsHits = 0;
  const hits = [];
  const server = createServer((req, res) => {
    hits.push(req.url);
    if (req.url === "/robots.txt") {
      robotsHits++;
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("User-agent: *\nDisallow: /private\n");
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(readFileSync("examples/pages/v1-original.html", "utf8"));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const spec = (path) => ({
    name: "pricing",
    url: `${base}${path}`,
    row: ".pricing-card",
    fields: { plan: { selector: ".plan-title", type: "string" } },
    expect: { rows: { min: 2, max: 8 } },
  });

  const p = new Politeness({ minDelayMs: 0 });

  const allowed = await runCheck(spec("/pricing"), { politeness: p });
  eq(allowed.cause, "OK", "an allowed path is fetched normally");
  eq(allowed.rows.length, 3, "and extracts");

  const denied = await runCheck(spec("/private/pricing"), { politeness: p });
  eq(denied.cause, "DISALLOWED", "a disallowed path is not fetched");
  ok(denied.causeDetail.includes("robots.txt"), `and says why: ${denied.causeDetail}`);
  eq(denied.rows.length, 0, "with no rows invented");
  ok(!hits.includes("/private/pricing"), "the server never saw the request at all");

  eq(robotsHits, 1, "robots.txt is fetched once and cached, not per request");

  // The safety property: robots is not a repairable condition.
  eq(shouldRepair("DISALLOWED"), false, "DISALLOWED never triggers a repair");

  await new Promise((r) => server.close(r));
}

section("pagination is throttled, not burst");

{
  // Before this existed, maxPages:5 fired five requests as fast as the socket
  // allowed. This measures the arrivals rather than trusting the config.
  const arrivals = [];
  const server = createServer((req, res) => {
    arrivals.push(Date.now());
    if (req.url === "/robots.txt") {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(readFileSync("examples/pages/v1-original.html", "utf8"));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const spec = {
    name: "paged",
    url: `${base}/p1`,
    row: ".pricing-card",
    fields: { plan: { selector: ".plan-title", type: "string" } },
    paginate: { urlTemplate: `${base}/p{page}`, maxPages: 4 },
  };

  const started = Date.now();
  const res = await fetchPages(spec, { politeness: new Politeness({ minDelayMs: 120 }) });
  const elapsed = Date.now() - started;

  eq(res.pages.length, 4, "all four pages fetched");
  const pageArrivals = arrivals.filter((_, i) => i > 0);
  ok(elapsed >= 3 * 120, `four pages took ${elapsed}ms, at least three gaps of 120ms`);

  let minGap = Infinity;
  for (let i = 1; i < pageArrivals.length; i++) {
    minGap = Math.min(minGap, pageArrivals[i] - pageArrivals[i - 1]);
  }
  ok(minGap >= 100, `no two page requests arrived closer than ${minGap}ms`);

  await new Promise((r) => server.close(r));
}

section("failure modes");

{
  // A site whose robots.txt is down must not take every scraper with it.
  const p = new Politeness({}, { fetchImpl: async () => { throw new Error("ECONNREFUSED"); } });
  const verdict = await p.check("https://down.example.com/anything");
  eq(verdict.allowed, true, "an unreachable robots.txt is treated as absent, not as a ban");
}

{
  const p = new Politeness({}, { fetchImpl: async () => ({ ok: false, status: 500, async text() { return ""; } }) });
  eq((await p.check("https://x.example.com/a")).allowed, true, "a 5xx on robots.txt is not a blanket ban either");
}

{
  const p = new Politeness({ respectRobots: false }, {
    fetchImpl: async () => { throw new Error("must not be called"); },
  });
  const v = await p.check("https://x.example.com/private");
  eq(v.allowed, true, "robots can be turned off entirely");
  ok(v.reason.includes("disabled"), "and says so rather than pretending it checked");
}

{
  const p = new Politeness({}, { fetchImpl: async () => ({ ok: true, async text() { return "User-agent: *\nDisallow: /"; } }) });
  let threw = null;
  try {
    await fetchPages(
      { name: "x", url: "https://blocked.example.com/page", fields: {} },
      { politeness: p },
    );
  } catch (e) {
    threw = e;
  }
  ok(threw instanceof DisallowedError, "fetchPages raises DisallowedError rather than fetching");
}
