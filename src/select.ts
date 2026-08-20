/**
 * A CSS selector engine covering the subset scrapers actually use:
 * tag / .class / #id / [attr op val] / * , the four combinators, :not(),
 * :first-child, :last-child and :nth-child(An+B).
 */
import { type ElementNode, children, classList, descendants } from "./html.js";

type Simple =
  | { kind: "tag"; value: string }
  | { kind: "universal" }
  | { kind: "class"; value: string }
  | { kind: "id"; value: string }
  | { kind: "attr"; name: string; op: string | null; value: string | null }
  | { kind: "pseudo"; name: string; arg: string | null };

type Combinator = " " | ">" | "+" | "~";

interface Compound {
  simples: Simple[];
  /** Combinator joining this compound to the one on its left. */
  lead: Combinator | null;
}

export class SelectorError extends Error {}

const cache = new Map<string, Compound[][]>();

export function parseSelector(input: string): Compound[][] {
  const hit = cache.get(input);
  if (hit) return hit;
  const groups = splitTopLevel(input, ",").map((g) => parseSequence(g.trim()));
  if (groups.some((g) => g.length === 0)) throw new SelectorError(`empty selector in "${input}"`);
  cache.set(input, groups);
  return groups;
}

/** Split on a delimiter, ignoring anything inside brackets, parens or quotes. */
function splitTopLevel(s: string, delim: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quote) {
      if (c === quote && s[i - 1] !== "\\") quote = null;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === "[" || c === "(") depth++;
    else if (c === "]" || c === ")") depth--;
    else if (c === delim && depth === 0) {
      out.push(s.slice(start, i));
      start = i + 1;
    }
  }
  out.push(s.slice(start));
  return out;
}

function parseSequence(seq: string): Compound[] {
  const out: Compound[] = [];
  let i = 0;
  let pendingCombinator: Combinator | null = null;

  while (i < seq.length) {
    if (/\s/.test(seq[i]!)) {
      let j = i;
      while (j < seq.length && /\s/.test(seq[j]!)) j++;
      // Whitespace is a descendant combinator only when a compound follows it
      // and no explicit combinator is already pending — the space in "a > b"
      // must not downgrade the ">" that was just read.
      if (
        j < seq.length &&
        !">+~".includes(seq[j]!) &&
        out.length > 0 &&
        pendingCombinator === null
      ) {
        pendingCombinator = " ";
      }
      i = j;
      continue;
    }
    if (">+~".includes(seq[i]!)) {
      pendingCombinator = seq[i] as Combinator;
      i++;
      continue;
    }
    const { simples, next } = parseCompound(seq, i);
    if (simples.length === 0) throw new SelectorError(`cannot parse "${seq}" at ${i}`);
    out.push({ simples, lead: out.length === 0 ? null : pendingCombinator ?? " " });
    pendingCombinator = null;
    i = next;
  }
  return out;
}

function parseCompound(s: string, from: number): { simples: Simple[]; next: number } {
  const simples: Simple[] = [];
  let i = from;

  while (i < s.length) {
    const c = s[i]!;
    if (/\s/.test(c) || ">+~,".includes(c)) break;

    if (c === "*") { simples.push({ kind: "universal" }); i++; continue; }

    if (c === "." || c === "#") {
      let j = i + 1;
      while (j < s.length && /[\w-]/.test(s[j]!)) j++;
      const value = s.slice(i + 1, j);
      if (!value) throw new SelectorError(`empty ${c === "." ? "class" : "id"} in "${s}"`);
      simples.push(c === "." ? { kind: "class", value } : { kind: "id", value });
      i = j;
      continue;
    }

    if (c === "[") {
      const end = s.indexOf("]", i);
      if (end === -1) throw new SelectorError(`unclosed [ in "${s}"`);
      const body = s.slice(i + 1, end);
      const m = /^([\w:-]+)\s*(?:([~^$*|]?=)\s*(.*))?$/.exec(body.trim());
      if (!m) throw new SelectorError(`bad attribute selector [${body}]`);
      let value: string | null = m[3] ?? null;
      if (value !== null) {
        value = value.trim();
        const first = value[0];
        const last = value[value.length - 1];
        if (value.length >= 2 && (first === '"' || first === "'") && last === first) {
          value = value.slice(1, -1);
        }
      }
      simples.push({ kind: "attr", name: m[1]!.toLowerCase(), op: m[2] ?? null, value });
      i = end + 1;
      continue;
    }

    if (c === ":") {
      let j = i + 1;
      if (s[j] === ":") j++; // tolerate ::pseudo-element, treated as a no-op filter
      const nameStart = j;
      while (j < s.length && /[\w-]/.test(s[j]!)) j++;
      const name = s.slice(nameStart, j).toLowerCase();
      let arg: string | null = null;
      if (s[j] === "(") {
        let depth = 1;
        let k = j + 1;
        while (k < s.length && depth > 0) {
          if (s[k] === "(") depth++;
          else if (s[k] === ")") depth--;
          if (depth > 0) k++;
        }
        arg = s.slice(j + 1, k);
        j = k + 1;
      }
      simples.push({ kind: "pseudo", name, arg });
      i = j;
      continue;
    }

    if (/[\w-]/.test(c)) {
      // A colon here starts a pseudo-class, so it must not be eaten as part of
      // the tag name: "p:nth-child(3)" is a p, not a tag called "p:nth-child".
      let j = i;
      while (j < s.length && /[\w-]/.test(s[j]!)) j++;
      simples.push({ kind: "tag", value: s.slice(i, j).toLowerCase() });
      i = j;
      continue;
    }
    throw new SelectorError(`unexpected "${c}" in "${s}"`);
  }
  return { simples, next: i };
}

/* ---------- matching ---------- */

function elementIndex(el: ElementNode): { index: number; total: number } {
  const parent = el.parent;
  if (!parent) return { index: 1, total: 1 };
  const sibs = children(parent);
  return { index: sibs.indexOf(el) + 1, total: sibs.length };
}

function parseNth(arg: string): { a: number; b: number } | null {
  const s = arg.replace(/\s+/g, "").toLowerCase();
  if (s === "odd") return { a: 2, b: 1 };
  if (s === "even") return { a: 2, b: 0 };
  if (/^[+-]?\d+$/.test(s)) return { a: 0, b: parseInt(s, 10) };
  const m = /^([+-]?\d*)n([+-]\d+)?$/.exec(s);
  if (!m) return null;
  const rawA = m[1]!;
  const a = rawA === "" || rawA === "+" ? 1 : rawA === "-" ? -1 : parseInt(rawA, 10);
  return { a, b: m[2] ? parseInt(m[2], 10) : 0 };
}

function nthMatches(index: number, a: number, b: number): boolean {
  if (a === 0) return index === b;
  const k = (index - b) / a;
  return Number.isInteger(k) && k >= 0;
}

function attrMatches(el: ElementNode, s: Extract<Simple, { kind: "attr" }>): boolean {
  const actual = el.attrs[s.name];
  if (actual === undefined) return false;
  if (s.op === null || s.value === null) return true;
  switch (s.op) {
    case "=": return actual === s.value;
    case "^=": return s.value !== "" && actual.startsWith(s.value);
    case "$=": return s.value !== "" && actual.endsWith(s.value);
    case "*=": return s.value !== "" && actual.includes(s.value);
    case "~=": return actual.split(/\s+/).includes(s.value);
    case "|=": return actual === s.value || actual.startsWith(s.value + "-");
    default: return false;
  }
}

function matchesSimple(el: ElementNode, s: Simple): boolean {
  switch (s.kind) {
    case "universal": return true;
    case "tag": return el.tag === s.value;
    case "class": return classList(el).includes(s.value);
    case "id": return el.attrs["id"] === s.value;
    case "attr": return attrMatches(el, s);
    case "pseudo": {
      switch (s.name) {
        case "first-child": return elementIndex(el).index === 1;
        case "last-child": {
          const { index, total } = elementIndex(el);
          return index === total;
        }
        case "only-child": return elementIndex(el).total === 1;
        case "nth-child": {
          if (!s.arg) return false;
          const nth = parseNth(s.arg);
          if (!nth) return false;
          return nthMatches(elementIndex(el).index, nth.a, nth.b);
        }
        case "not": {
          if (!s.arg) return false;
          return !parseSelector(s.arg).some(
            (g) => g.length === 1 && g[0]!.simples.every((x) => matchesSimple(el, x)),
          );
        }
        // Unknown or state pseudo-classes (:hover, ::before) never exclude.
        default: return true;
      }
    }
  }
}

function matchesCompound(el: ElementNode, c: Compound): boolean {
  return c.simples.every((s) => matchesSimple(el, s));
}

function matchSequence(
  el: ElementNode,
  seq: Compound[],
  at: number,
  boundary: ElementNode | null,
): boolean {
  if (!matchesCompound(el, seq[at]!)) return false;
  if (at === 0) return true;

  const combinator = seq[at]!.lead!;
  const prev = at - 1;

  if (combinator === ">") {
    const p = el.parent;
    if (!p || p === boundary || p.tag === "#document") return false;
    return matchSequence(p, seq, prev, boundary);
  }
  if (combinator === " ") {
    let p = el.parent;
    while (p && p !== boundary && p.tag !== "#document") {
      if (matchSequence(p, seq, prev, boundary)) return true;
      p = p.parent;
    }
    return false;
  }

  const parent = el.parent;
  if (!parent) return false;
  const sibs = children(parent);
  const idx = sibs.indexOf(el);
  if (combinator === "+") {
    const s = sibs[idx - 1];
    return s ? matchSequence(s, seq, prev, boundary) : false;
  }
  for (let i = idx - 1; i >= 0; i--) {
    if (matchSequence(sibs[i]!, seq, prev, boundary)) return true;
  }
  return false;
}

export function matches(
  el: ElementNode,
  selector: string,
  boundary: ElementNode | null = null,
): boolean {
  return parseSelector(selector).some((seq) => matchSequence(el, seq, seq.length - 1, boundary));
}

/**
 * Descendants of `root` matching `selector`. Ancestor traversal during matching
 * stops at `root`, so a selector evaluated inside a row cannot reach up into the
 * surrounding page to satisfy itself.
 */
export function querySelectorAll(root: ElementNode, selector: string): ElementNode[] {
  const groups = parseSelector(selector);
  return descendants(root).filter((el) =>
    groups.some((seq) => matchSequence(el, seq, seq.length - 1, root)),
  );
}

export function querySelector(root: ElementNode, selector: string): ElementNode | null {
  return querySelectorAll(root, selector)[0] ?? null;
}
