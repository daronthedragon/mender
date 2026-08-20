import type { FetchResult } from "./types.js";

const DEFAULT_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export interface FetchOptions {
  timeoutMs?: number;
  userAgent?: string;
  headers?: Record<string, string>;
}

/**
 * v0.1 fetches over plain HTTP. Server-rendered pages are the majority of what
 * scrapers point at, and staying browserless keeps the tool installable in
 * seconds and testable without a display. A browser adapter is the next cut.
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
    return {
      status: res.status,
      finalUrl: res.url || url,
      html,
      ms: Date.now() - started,
    };
  } catch (e) {
    const err = e as Error;
    // A network failure is not a page, and must never look like one to the
    // classifier: status 0 falls through to HTTP_ERROR, never to a repair.
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
