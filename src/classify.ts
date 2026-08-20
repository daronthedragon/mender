import { type ElementNode, normText } from "./html.js";
import { querySelector } from "./select.js";
import type { Cause, FetchResult, ScraperSpec, Violation } from "./types.js";

/**
 * The safety gate. Most contract failures are not layout changes, and repairing
 * selectors against a bot-check page would teach the scraper to extract captcha
 * text and then report itself healthy. Only LAYOUT_CHANGE earns a repair.
 */
export interface Classification {
  cause: Cause;
  detail: string;
}

const CHALLENGE_PHRASES = [
  "just a moment",
  "attention required",
  "checking your browser",
  "enable javascript and cookies to continue",
  "verify you are human",
  "are you a robot",
  "unusual traffic",
  "access denied",
  "request blocked",
  "too many requests",
  "rate limit exceeded",
  "ddos protection",
  "please complete the security check",
];

const CHALLENGE_SELECTORS = [
  "#cf-challenge-running",
  "#challenge-form",
  "#cf-wrapper",
  ".g-recaptcha",
  ".h-captcha",
  "[data-sitekey]",
  "script[src*=recaptcha]",
  "script[src*=hcaptcha]",
  "script[src*=challenge-platform]",
];

/** A page small enough that a challenge phrase in it is almost certainly the page. */
const SMALL_PAGE_BYTES = 20_000;

function challengeEvidence(doc: ElementNode, html: string): string | null {
  for (const sel of CHALLENGE_SELECTORS) {
    try {
      if (querySelector(doc, sel)) return `challenge element ${sel}`;
    } catch {
      // A selector this module owns should always parse; ignore if it does not.
    }
  }
  if (html.length <= SMALL_PAGE_BYTES) {
    const text = normText(doc).toLowerCase();
    for (const phrase of CHALLENGE_PHRASES) {
      if (text.includes(phrase)) return `challenge phrase ${JSON.stringify(phrase)}`;
    }
  }
  return null;
}

function sameTarget(a: string, b: string): boolean {
  try {
    const x = new URL(a);
    const y = new URL(b);
    const host = (h: string) => h.replace(/^www\./, "").toLowerCase();
    const path = (p: string) => (p.endsWith("/") && p.length > 1 ? p.slice(0, -1) : p);
    return host(x.hostname) === host(y.hostname) && path(x.pathname) === path(y.pathname);
  } catch {
    return a === b;
  }
}

export function classify(
  fetched: FetchResult,
  doc: ElementNode,
  spec: ScraperSpec,
  violations: Violation[],
): Classification {
  // 403 and 429 are the shape of being blocked, not of a broken page.
  if (fetched.status === 403 || fetched.status === 429) {
    return { cause: "BLOCKED", detail: `HTTP ${fetched.status}` };
  }

  const evidence = challengeEvidence(doc, fetched.html);
  if (evidence) return { cause: "BLOCKED", detail: evidence };

  // status 0 is this tool's marker for a transport failure, not a page.
  if (fetched.status === 0 || fetched.status >= 400) {
    return {
      cause: "HTTP_ERROR",
      detail: fetched.status === 0 ? "network error before any response" : `HTTP ${fetched.status}`,
    };
  }

  if (normText(doc).length < 50) {
    return {
      cause: "EMPTY",
      detail: `page carried ${normText(doc).length} chars of text (${fetched.html.length} bytes of html)`,
    };
  }

  if (!sameTarget(fetched.finalUrl, spec.url)) {
    return { cause: "REDIRECTED", detail: `${spec.url} -> ${fetched.finalUrl}` };
  }

  if (violations.length > 0) {
    return {
      cause: "LAYOUT_CHANGE",
      detail: `page served normally but ${violations.length} contract violation${violations.length === 1 ? "" : "s"}`,
    };
  }

  return { cause: "OK", detail: "contract satisfied" };
}

/** Repair is only ever attempted for one cause. */
export function shouldRepair(cause: Cause): boolean {
  return cause === "LAYOUT_CHANGE";
}
