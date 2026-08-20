/**
 * Politeness.
 *
 * BLOCKED is the one cause mender can never repair: when a site decides you are
 * a nuisance, no selector fix helps. Everything else in this project is about
 * recovering from failure; this is the only part that prevents one.
 *
 * Before this existed a spec with `maxPages: 10` fired ten requests as fast as
 * the socket allowed, `watch` ran four scrapers at once against a host that may
 * be the same host, and robots.txt was never fetched at all.
 */

export interface RobotsRules {
  /** Path prefixes that are disallowed, longest first. */
  disallow: string[];
  /** Path prefixes explicitly allowed; these beat a longer disallow only if longer. */
  allow: string[];
  /** Seconds the site asked us to wait between requests. */
  crawlDelay?: number;
  /** No robots.txt, or one that could not be read: nothing is forbidden. */
  empty: boolean;
}

export const EMPTY_RULES: RobotsRules = { disallow: [], allow: [], empty: true };

function decodePath(p: string): string {
  try {
    return decodeURIComponent(p);
  } catch {
    return p;
  }
}

/**
 * Parse robots.txt for one user agent.
 *
 * Groups are matched by the most specific agent that applies: an exact-ish
 * match on our token wins over `*`. Consecutive `User-agent:` lines share the
 * group that follows them, which is the part naive parsers get wrong.
 */
export function parseRobots(text: string, userAgent: string): RobotsRules {
  const ua = userAgent.toLowerCase();
  const groups: { agents: string[]; disallow: string[]; allow: string[]; crawlDelay?: number }[] = [];
  let current: (typeof groups)[number] | null = null;
  let lastLineWasAgent = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();

    if (field === "user-agent") {
      if (!current || !lastLineWasAgent) {
        current = { agents: [], disallow: [], allow: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastLineWasAgent = true;
      continue;
    }
    lastLineWasAgent = false;
    if (!current) continue;

    if (field === "disallow") {
      // "Disallow:" with an empty value means allow everything, not block it.
      if (value) current.disallow.push(decodePath(value));
    } else if (field === "allow") {
      if (value) current.allow.push(decodePath(value));
    } else if (field === "crawl-delay") {
      const n = Number(value);
      if (Number.isFinite(n) && n >= 0) current.crawlDelay = n;
    }
  }

  const exact = groups.find((g) => g.agents.some((a) => a !== "*" && ua.includes(a)));
  const wildcard = groups.find((g) => g.agents.includes("*"));
  const chosen = exact ?? wildcard;
  if (!chosen) return { ...EMPTY_RULES };

  return {
    disallow: [...chosen.disallow].sort((a, b) => b.length - a.length),
    allow: [...chosen.allow].sort((a, b) => b.length - a.length),
    ...(chosen.crawlDelay !== undefined ? { crawlDelay: chosen.crawlDelay } : {}),
    empty: chosen.disallow.length === 0,
  };
}

/** Does a rule prefix match a path? `*` and a trailing `$` are honoured. */
function ruleMatches(rule: string, path: string): boolean {
  if (!rule.includes("*") && !rule.endsWith("$")) return path.startsWith(rule);
  const anchored = rule.endsWith("$");
  const body = anchored ? rule.slice(0, -1) : rule;
  const pattern =
    "^" +
    body
      .split("*")
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*") +
    (anchored ? "$" : "");
  try {
    return new RegExp(pattern).test(path);
  } catch {
    return false;
  }
}

/**
 * The longest matching rule wins, and Allow beats Disallow at equal length —
 * which is how a site carves an exception out of a broad block.
 */
export function isPathAllowed(rules: RobotsRules, path: string): boolean {
  let bestDisallow = -1;
  let bestAllow = -1;
  for (const rule of rules.disallow) {
    if (ruleMatches(rule, path)) bestDisallow = Math.max(bestDisallow, rule.length);
  }
  for (const rule of rules.allow) {
    if (ruleMatches(rule, path)) bestAllow = Math.max(bestAllow, rule.length);
  }
  if (bestDisallow === -1) return true;
  return bestAllow >= bestDisallow;
}

export interface PolitenessConfig {
  /** Fetch and obey robots.txt. Default true. */
  respectRobots?: boolean;
  /** Minimum gap between requests to the same host, in ms. Default 1000. */
  minDelayMs?: number;
  /** Cap on how long a site's own Crawl-delay can hold us, in ms. Default 30s. */
  maxDelayMs?: number;
  /** Token robots.txt groups are matched against. */
  userAgent?: string;
  /** How long a fetched robots.txt stays good, in ms. Default one hour. */
  robotsTtlMs?: number;
}

export interface PolitenessOptions {
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface Verdict {
  allowed: boolean;
  reason: string;
}

/**
 * Per-host rate limiting and robots.txt, shared across every request a run
 * makes — pagination included, which is where the burst used to come from.
 */
export class Politeness {
  private readonly respectRobots: boolean;
  private readonly minDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly userAgent: string;
  private readonly ttl: number;
  private readonly doFetch: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  /** host -> when the next request to it may go out. */
  private readonly nextFree = new Map<string, number>();
  private readonly robots = new Map<string, { rules: RobotsRules; at: number }>();
  /** host -> in-flight robots fetch, so N scrapers do not fetch it N times. */
  private readonly inflight = new Map<string, Promise<RobotsRules>>();

  constructor(cfg: PolitenessConfig = {}, opts: PolitenessOptions = {}) {
    this.respectRobots = cfg.respectRobots !== false;
    this.minDelayMs = cfg.minDelayMs ?? 1000;
    this.maxDelayMs = cfg.maxDelayMs ?? 30_000;
    this.userAgent = (cfg.userAgent ?? "mender").toLowerCase();
    this.ttl = cfg.robotsTtlMs ?? 3_600_000;
    this.doFetch = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async rulesFor(url: string): Promise<RobotsRules> {
    let origin: string;
    try {
      origin = new URL(url).origin;
    } catch {
      return { ...EMPTY_RULES };
    }

    const cached = this.robots.get(origin);
    if (cached && this.now() - cached.at < this.ttl) return cached.rules;

    const pending = this.inflight.get(origin);
    if (pending) return pending;

    const job = (async (): Promise<RobotsRules> => {
      let rules: RobotsRules = { ...EMPTY_RULES };
      try {
        const res = await this.doFetch(`${origin}/robots.txt`, {
          headers: { "user-agent": this.userAgent },
        });
        // 404 means no rules. 5xx is ambiguous, and treating an outage as a
        // blanket ban would take every scraper down with the site's own bug.
        if (res.ok) rules = parseRobots(await res.text(), this.userAgent);
      } catch {
        // Unreachable robots.txt is treated as absent, for the same reason.
      }
      this.robots.set(origin, { rules, at: this.now() });
      this.inflight.delete(origin);
      return rules;
    })();

    this.inflight.set(origin, job);
    return job;
  }

  async check(url: string): Promise<Verdict> {
    if (!this.respectRobots) return { allowed: true, reason: "robots.txt not consulted (disabled)" };
    let path: string;
    try {
      const u = new URL(url);
      path = u.pathname + u.search;
    } catch {
      return { allowed: true, reason: "unparseable url" };
    }
    const rules = await this.rulesFor(url);
    if (rules.empty) return { allowed: true, reason: "robots.txt allows it" };
    return isPathAllowed(rules, path)
      ? { allowed: true, reason: "robots.txt allows it" }
      : { allowed: false, reason: `robots.txt disallows ${path}` };
  }

  /** Block until this host may be contacted again, then claim the slot. */
  async wait(url: string): Promise<number> {
    let host: string;
    try {
      host = new URL(url).host;
    } catch {
      return 0;
    }

    const rules = this.respectRobots ? await this.rulesFor(url) : { ...EMPTY_RULES };
    const siteDelay = rules.crawlDelay !== undefined ? rules.crawlDelay * 1000 : 0;
    const delay = Math.min(this.maxDelayMs, Math.max(this.minDelayMs, siteDelay));

    const now = this.now();
    const free = this.nextFree.get(host) ?? 0;
    const waitFor = Math.max(0, free - now);
    // Claim the slot before awaiting, so concurrent callers queue rather than
    // all reading the same "free" moment and firing together.
    this.nextFree.set(host, Math.max(now, free) + delay);
    if (waitFor > 0) await this.sleep(waitFor);
    return waitFor;
  }

  /** Both gates, in the order that avoids waiting for a request we will refuse. */
  async clear(url: string): Promise<Verdict> {
    const verdict = await this.check(url);
    if (!verdict.allowed) return verdict;
    await this.wait(url);
    return verdict;
  }
}
