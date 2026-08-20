import { type ElementNode, serialize } from "./html.js";
import { querySelectorAll } from "./select.js";
import { parseSelector, SelectorError } from "./select.js";
import { extract, rowElements } from "./extract.js";
import { ROW_TARGET } from "./propose.js";
import type { Candidate, ScraperSpec } from "./types.js";

/**
 * The model sits behind the same three gates as the heuristics. It proposes
 * strings; it never decides anything. A proposal that cannot be verified is
 * discarded exactly like a heuristic one, which is what makes it safe to let a
 * model near a scraper that writes to a database.
 */
export interface ModelClient {
  readonly name: string;
  complete(req: { system: string; user: string; maxTokens: number }): Promise<string>;
}

export const DEFAULT_MODEL = "claude-sonnet-5";

export function anthropicClient(opts: {
  apiKey?: string | undefined;
  model?: string | undefined;
  baseUrl?: string | undefined;
} = {}): ModelClient | null {
  const apiKey = opts.apiKey ?? process.env["ANTHROPIC_API_KEY"];
  if (!apiKey) return null;
  const model = opts.model ?? process.env["MENDER_MODEL"] ?? DEFAULT_MODEL;
  const baseUrl = opts.baseUrl ?? "https://api.anthropic.com";

  return {
    name: model,
    async complete(req) {
      const res = await fetch(`${baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model,
          max_tokens: req.maxTokens,
          system: req.system,
          messages: [{ role: "user", content: req.user }],
        }),
      });
      if (!res.ok) {
        throw new Error(`anthropic ${res.status}: ${(await res.text()).slice(0, 300)}`);
      }
      const body = (await res.json()) as { content?: { type: string; text?: string }[] };
      return (body.content ?? [])
        .filter((c) => c.type === "text")
        .map((c) => c.text ?? "")
        .join("");
    },
  };
}

const SYSTEM = `You repair broken CSS selectors for a web scraper.

You are given the field that broke, examples of the markup from pages where the
scraper WORKED (with the value it extracted), and the markup from the page where
it now FAILS.

Return CSS selectors that would extract the same KIND of value from the new
markup. Rules:
- Selectors are evaluated relative to the row element shown, not the document.
- Prefer stable hooks: data-testid, data-test, itemprop, semantic class names.
- Avoid build-tool hashes (css-1a2b3c, sc-xyz123) and avoid :nth-child unless
  nothing else identifies the element.
- Return the selector for the element that HOLDS the value, not an ancestor
  that merely contains it.
- If the value genuinely no longer exists on the page, return an empty list.
  A wrong selector is far worse than no selector.

Respond with JSON only, no prose, no code fence:
{"selectors": ["...", "..."], "note": "one short sentence"}`;

const MAX_SAMPLES = 2;
const MAX_PROMPT_CHARS = 14_000;

function rowSamples(doc: ElementNode, spec: ScraperSpec, rowSelector?: string): ElementNode[] {
  const rows = rowSelector ? querySelectorAll(doc, rowSelector) : rowElements(doc, spec);
  return rows.slice(0, MAX_SAMPLES);
}

function buildPrompt(input: LlmProposalInput): string {
  const { spec, target, liveDoc, goldenDocs } = input;
  const parts: string[] = [];

  if (target === ROW_TARGET) {
    parts.push(`FIELD: the row selector itself`);
    parts.push(`CURRENT SELECTOR: ${JSON.stringify(spec.row ?? "")}`);
    parts.push(
      `It should match each repeating record on the page. It currently matches ${
        spec.row ? querySelectorAll(liveDoc, spec.row).length : 0
      } elements on the new page.`,
    );
  } else {
    const field = spec.fields[target];
    parts.push(`FIELD: ${target}`);
    parts.push(`CURRENT SELECTOR: ${JSON.stringify(field?.selector ?? "")}`);
    parts.push(`EXPECTED TYPE: ${field?.type}${field?.attr ? ` (from attribute "${field.attr}")` : ""}`);
    if (field?.min !== undefined) parts.push(`MINIMUM VALUE: ${field.min}`);
    if (field?.minItems !== undefined) parts.push(`MINIMUM ITEMS: ${field.minItems}`);
  }

  parts.push("");
  parts.push("=== MARKUP FROM PAGES THAT WORKED ===");
  for (const g of goldenDocs.slice(0, MAX_SAMPLES)) {
    const rows = rowSamples(g.doc, spec);
    for (const row of rows) {
      if (target !== ROW_TARGET) {
        const value = extract(row.parent ?? row, spec)[0]?.fields[target]?.raw;
        if (value) parts.push(`# extracted value was: ${JSON.stringify(value)}`);
      }
      parts.push(serialize(row, { maxDepth: 5 }));
    }
  }

  parts.push("");
  parts.push("=== MARKUP FROM THE PAGE THAT NOW FAILS ===");
  const liveRows =
    target === ROW_TARGET
      ? [liveDoc]
      : rowSamples(liveDoc, spec, input.liveRowSelector ?? spec.row);
  for (const row of liveRows) {
    parts.push(serialize(row, { maxDepth: target === ROW_TARGET ? 4 : 5 }));
  }

  parts.push("");
  parts.push(
    target === ROW_TARGET
      ? "Return selectors matching the repeating record container on the new page."
      : `Return selectors, relative to a row element, for the ${target} value on the new page.`,
  );

  const prompt = parts.join("\n");
  return prompt.length > MAX_PROMPT_CHARS
    ? prompt.slice(0, MAX_PROMPT_CHARS) + "\n…[truncated]"
    : prompt;
}

/** Pull the JSON object out of a reply that may be fenced or padded with prose. */
export function parseModelReply(raw: string): { selectors: string[]; note: string } {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(raw);
  const body = fenced ? fenced[1]! : raw;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end <= start) return { selectors: [], note: "no json in reply" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(body.slice(start, end + 1));
  } catch {
    return { selectors: [], note: "unparseable json in reply" };
  }
  const obj = parsed as { selectors?: unknown; note?: unknown };
  const selectors = Array.isArray(obj.selectors)
    ? obj.selectors.filter((s): s is string => typeof s === "string" && s.trim().length > 0)
    : [];
  return {
    selectors: selectors.map((s) => s.trim()),
    note: typeof obj.note === "string" ? obj.note : "",
  };
}

export interface LlmProposalInput {
  spec: ScraperSpec;
  target: string;
  liveDoc: ElementNode;
  goldenDocs: { source: string; doc: ElementNode }[];
  liveRowSelector?: string;
}

const MAX_MODEL_CANDIDATES = 6;

export async function proposeWithModel(
  client: ModelClient,
  input: LlmProposalInput,
): Promise<Candidate[]> {
  let reply: string;
  try {
    reply = await client.complete({
      system: SYSTEM,
      user: buildPrompt(input),
      maxTokens: 700,
    });
  } catch (e) {
    // A model outage must degrade to "no repair", never to a wrong repair.
    return [
      {
        target: input.target,
        selector: "",
        score: 0,
        reason: `model call failed: ${(e as Error).message}`,
      },
    ].filter((c) => c.selector !== "");
  }

  const { selectors, note } = parseModelReply(reply);
  const out: Candidate[] = [];
  const seen = new Set<string>();

  for (const selector of selectors) {
    if (seen.has(selector) || out.length >= MAX_MODEL_CANDIDATES) continue;
    seen.add(selector);
    // Validate with our own parser before it can reach verification.
    try {
      parseSelector(selector);
    } catch (e) {
      if (e instanceof SelectorError) continue;
      throw e;
    }
    out.push({
      target: input.target,
      selector,
      score: 0.5 - out.length * 0.01,
      reason: `${client.name}${note ? `: ${note}` : ""}`,
    });
  }
  return out;
}
