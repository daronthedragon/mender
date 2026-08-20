import type { FetchResult } from "./types.js";

/**
 * Client-rendered pages need a real browser, and a real browser is a large
 * dependency. Rather than spend the project's zero-dependency property on every
 * user, Playwright is loaded lazily and only when a spec actually asks to
 * render. Installs stay seconds long for the majority of scrapers that point at
 * server-rendered HTML, and the ones that need a browser opt in explicitly.
 */
export interface RenderOptions {
  /** Wait until this selector appears before reading the page. */
  waitFor?: string;
  /** Additional settle time after load, in milliseconds. */
  waitMs?: number;
  timeoutMs?: number;
  headers?: Record<string, string>;
  userAgent?: string;
}

export interface PageFetcher {
  readonly name: string;
  fetch(url: string, opts?: RenderOptions): Promise<FetchResult>;
  close(): Promise<void>;
}

export class BrowserUnavailableError extends Error {}

export const INSTALL_HINT =
  "this spec asks for browser rendering, which needs Playwright:\n" +
  "  npm install playwright && npx playwright install chromium\n" +
  "Playwright is an optional peer dependency — mender itself installs with none.";

/**
 * Resolved through a variable so the module specifier is not statically
 * analysed: the package is genuinely optional and must not become a build-time
 * requirement.
 */
async function loadPlaywright(): Promise<any> {
  const specifier = "playwright";
  try {
    return await import(specifier);
  } catch (e) {
    throw new BrowserUnavailableError(`${INSTALL_HINT}\n(import failed: ${(e as Error).message})`);
  }
}

export async function playwrightFetcher(
  opts: { headless?: boolean; engine?: "chromium" | "firefox" | "webkit" } = {},
): Promise<PageFetcher> {
  const pw = await loadPlaywright();
  const engine = opts.engine ?? "chromium";
  const launcher = pw[engine];
  if (!launcher) throw new BrowserUnavailableError(`playwright has no "${engine}" engine`);
  const browser = await launcher.launch({ headless: opts.headless ?? true });

  return {
    name: `playwright:${engine}`,
    async fetch(url, render = {}) {
      const started = Date.now();
      const context = await browser.newContext({
        ...(render.userAgent ? { userAgent: render.userAgent } : {}),
        ...(render.headers ? { extraHTTPHeaders: render.headers } : {}),
      });
      const page = await context.newPage();
      try {
        const response = await page.goto(url, {
          waitUntil: "domcontentloaded",
          timeout: render.timeoutMs ?? 30_000,
        });
        if (render.waitFor) {
          await page.waitForSelector(render.waitFor, { timeout: render.timeoutMs ?? 30_000 });
        }
        if (render.waitMs) await page.waitForTimeout(render.waitMs);

        return {
          status: response ? response.status() : 0,
          finalUrl: page.url(),
          html: await page.content(),
          ms: Date.now() - started,
        };
      } catch (e) {
        const err = e as Error;
        // Same contract as the plain fetcher: a failure is status 0, which the
        // classifier turns into HTTP_ERROR and never into a repairable page.
        return {
          status: 0,
          finalUrl: url,
          html: `<!-- render failed: ${err.name}: ${err.message} -->`,
          ms: Date.now() - started,
        };
      } finally {
        await context.close();
      }
    },
    async close() {
      await browser.close();
    },
  };
}
