import { parse } from "./html.js";
import { querySelector } from "./select.js";
import type { AuthSpec, FetchResult, FetchedPages, ScraperSpec } from "./types.js";

const DEFAULT_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export interface FetchOptions {
  timeoutMs?: number;
  userAgent?: string;
  headers?: Record<string, string>;
}

export class AuthError extends Error {}

/**
 * Resolve the named environment variables into real headers. A spec never holds
 * a secret, so a missing variable is a configuration error worth naming loudly
 * rather than a silent unauthenticated request that looks like a layout change.
 */
export function authHeaders(auth: AuthSpec | undefined, env = process.env): Record<string, string> {
  if (!auth) return {};
  const out: Record<string, string> = {};

  for (const [header, varName] of Object.entries(auth.headerEnv ?? {})) {
    const value = env[varName];
    if (!value) throw new AuthError(`auth: environment variable ${varName} is not set (for header ${header})`);
    out[header.toLowerCase()] = value;
  }

  if (auth.cookieEnv) {
    const value = env[auth.cookieEnv];
    if (!value) throw new AuthError(`auth: environment variable ${auth.cookieEnv} is not set (for the Cookie header)`);
    out["cookie"] = value;
  }

  if (auth.basicEnv) {
    const user = env[auth.basicEnv.user];
    const pass = env[auth.basicEnv.pass];
    if (!user || !pass) {
      throw new AuthError(
        `auth: basic auth needs ${auth.basicEnv.user} and ${auth.basicEnv.pass} to be set`,
      );
    }
    out["authorization"] = `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
  }
  return out;
}

/**
 * v0.2 fetches over plain HTTP. Server-rendered pages are the majority of what
 * scrapers point at, and staying browserless keeps the tool installable in
 * seconds and testable without a display.
 */
export async function fetchPage(url: string, opts: FetchOptions = {}): Promise<FetchResult> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 20_000);

  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "user-agent": opts.userAgent ?? DEFAULT_UA,
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "en-US,en;q=0.9",
        ...opts.headers,
      },
    });
    const html = await res.text();
    return { status: res.status, finalUrl: res.url || url, html, ms: Date.now() - started };
  } catch (e) {
    const err = e as Error;
    // A network failure is not a page. Status 0 is this tool's marker for that,
    // and the classifier turns it into HTTP_ERROR, never a repairable page.
    return {
      status: 0,
      finalUrl: url,
      html: `<!-- fetch failed: ${err.name}: ${err.message} -->`,
      ms: Date.now() - started,
    };
  } finally {
    clearTimeout(timer);
  }
}

function resolveHref(href: string, base: string): string | null {
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
}

/**
 * Fetch page one, then follow pagination up to the spec's hard cap. Stops early
 * on a non-200, a repeated URL, or a missing next link — an uncapped or looping
 * crawler is a bug, not a feature.
 */
export async function fetchPages(spec: ScraperSpec, opts: FetchOptions = {}): Promise<FetchedPages> {
  const headers = { ...opts.headers, ...authHeaders(spec.auth) };
  const withAuth: FetchOptions = { ...opts, headers };

  const paginate = spec.paginate;
  if (!paginate || paginate.maxPages <= 1) {
    const primary = await fetchPage(spec.url, withAuth);
    return { primary, pages: [primary] };
  }

  const pages: FetchResult[] = [];
  const seen = new Set<string>();

  if (paginate.urlTemplate) {
    const start = paginate.startPage ?? 1;
    for (let i = 0; i < paginate.maxPages; i++) {
      const url = paginate.urlTemplate.replace("{page}", String(start + i));
      if (seen.has(url)) break;
      seen.add(url);
      const page = await fetchPage(url, withAuth);
      pages.push(page);
      if (page.status !== 200) break;
    }
    return { primary: pages[0]!, pages };
  }

  let url: string | null = spec.url;
  while (url && pages.length < paginate.maxPages) {
    if (seen.has(url)) break;
    seen.add(url);
    const page: FetchResult = await fetchPage(url, withAuth);
    pages.push(page);
    if (page.status !== 200 || !paginate.next) break;

    const link = querySelector(parse(page.html), paginate.next);
    const href = link?.attrs["href"];
    url = href ? resolveHref(href, page.finalUrl) : null;
  }

  return { primary: pages[0]!, pages };
}
