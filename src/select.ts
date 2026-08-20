/**
 * A CSS selector engine covering the subset scrapers actually use:
 * tag / .class / #id / [attr op val] / * , the four combinators, :not(),
 * :first-child, :last-child and :nth-child(An+B).
 */
import {
  type ElementNode,
  childElementCount,
  children,
  classList,
  descendants,
  siblingIndex,
} from "./html.js";

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

/*
 * Position among element siblings. The parser records both numbers, so this is
 * a field read rather than the scan-and-indexOf it used to be — it sits in the
 * innermost loop of every :nth-child and sibling-combinator match.
 */
function elementIndexOf(el: ElementNode): number {
  return el.parent ? siblingIndex(el) + 1 : 1;
}

function elementTotal(el: ElementNode): number {
  return el.parent ? childElementCount(el.parent) : 1;
}

const NTH_INT = /^[+-]?\d+$/;
const NTH_AN_B = /^([+-]?\d*)n([+-]\d+)?$/;
const NTH_WS = /\s+/g;
const nthCache = new Map<string, { a: number; b: number } | null>();

function parseNth(arg: string): { a: number; b: number } | null {
  const cached = nthCache.get(arg);
  if (cached !== undefined) return cached;
  const parsed = parseNthUncached(arg);
  nthCache.set(arg, parsed);
  return parsed;
}

function parseNthUncached(arg: string): { a: number; b: number } | null {
  const s = arg.replace(NTH_WS, "").toLowerCase();
  if (s === "odd") return { a: 2, b: 1 };
  if (s === "even") return { a: 2, b: 0 };
  if (NTH_INT.test(s)) return { a: 0, b: parseInt(s, 10) };
  const m = NTH_AN_B.exec(s);
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
        case "first-child": return elementIndexOf(el) === 1;
        case "last-child": return elementIndexOf(el) === elementTotal(el);
        case "only-child": return elementTotal(el) === 1;
        case "nth-child": {
          if (!s.arg) return false;
          const nth = parseNth(s.arg);
          if (!nth) return false;
          return nthMatches(elementIndexOf(el), nth.a, nth.b);
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
  const idx = siblingIndex(el);
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
  const candidates = narrow(root, groups);
  const out: ElementNode[] = [];
  for (let i = 0; i < candidates.length; i++) {
    const el = candidates[i]!;
    for (let g = 0; g < groups.length; g++) {
      const seq = groups[g]!;
      if (matchSequence(el, seq, seq.length - 1, root)) {
        out.push(el);
        break;
      }
    }
  }
  return out;
}

/* ---------- candidate narrowing ---------- */

/*
 * An element can only satisfy a sequence if it satisfies the sequence's
 * rightmost compound, and that compound almost always names an id, a class or a
 * tag. Indexing a root by those three keys turns "test every descendant" into
 * "test the handful that could possibly match".
 *
 * The index is built on the *second* query against a root, so a root that is
 * only ever queried once still pays a single linear scan and nothing more.
 * Repair queries the same row hundreds of times, which is where this pays off.
 */

type IndexKey = { kind: "id" | "class" | "tag" | "attr"; value: string };

/** Positions into `descendants(root)`, so merges stay in document order. */
interface RootIndex {
  byId: Map<string, number[]>;
  byClass: Map<string, number[]>;
  byTag: Map<string, number[]>;
  /** Attribute name -> elements carrying it. Filled per name, on demand. */
  byAttr: Map<string, number[]>;
  all: ElementNode[];
}

const rootIndexes = new WeakMap<ElementNode, RootIndex>();
const rootQueries = new WeakMap<ElementNode, number>();
const groupKeys = new WeakMap<Compound[][], (IndexKey | null)[]>();

function keyOfCompound(c: Compound): IndexKey | null {
  let tag: string | null = null;
  let cls: string | null = null;
  let attr: string | null = null;
  const simples = c.simples;
  for (let i = 0; i < simples.length; i++) {
    const s = simples[i]!;
    if (s.kind === "id") return { kind: "id", value: s.value };
    if (s.kind === "class") { if (cls === null) cls = s.value; }
    else if (s.kind === "tag") { if (tag === null) tag = s.value; }
    else if (s.kind === "attr") { if (attr === null) attr = s.name; }
  }
  if (cls !== null) return { kind: "class", value: cls };
  if (attr !== null) return { kind: "attr", value: attr };
  if (tag !== null) return { kind: "tag", value: tag };
  return null;
}

function keysFor(groups: Compound[][]): (IndexKey | null)[] {
  let keys = groupKeys.get(groups);
  if (keys === undefined) {
    keys = groups.map((g) => keyOfCompound(g[g.length - 1]!));
    groupKeys.set(groups, keys);
  }
  return keys;
}

function put(map: Map<string, number[]>, key: string, pos: number): void {
  const arr = map.get(key);
  if (arr === undefined) map.set(key, [pos]);
  else if (arr[arr.length - 1] !== pos) arr.push(pos);
}

function buildIndex(root: ElementNode): RootIndex {
  const all = descendants(root);
  const byId = new Map<string, number[]>();
  const byClass = new Map<string, number[]>();
  const byTag = new Map<string, number[]>();
  for (let i = 0; i < all.length; i++) {
    const el = all[i]!;
    put(byTag, el.tag, i);
    const id = el.attrs["id"];
    if (id !== undefined) put(byId, id, i);
    const cls = classList(el);
    for (let j = 0; j < cls.length; j++) put(byClass, cls[j]!, i);
  }
  return { byId, byClass, byTag, byAttr: new Map(), all };
}

const NO_MATCH: number[] = [];

function bucket(idx: RootIndex, key: IndexKey): number[] {
  if (key.kind === "attr") {
    let hit = idx.byAttr.get(key.value);
    if (hit === undefined) {
      hit = [];
      const all = idx.all;
      for (let i = 0; i < all.length; i++) {
        if (all[i]!.attrs[key.value] !== undefined) hit.push(i);
      }
      idx.byAttr.set(key.value, hit);
    }
    return hit;
  }
  const map = key.kind === "id" ? idx.byId : key.kind === "class" ? idx.byClass : idx.byTag;
  return map.get(key.value) ?? NO_MATCH;
}

/** The elements worth testing, in document order. */
function narrow(root: ElementNode, groups: Compound[][]): ElementNode[] {
  const keys = keysFor(groups);
  for (let i = 0; i < keys.length; i++) if (keys[i] === null) return descendants(root);

  let idx = rootIndexes.get(root);
  if (idx === undefined) {
    const seen = (rootQueries.get(root) ?? 0) + 1;
    if (seen < 2) {
      rootQueries.set(root, seen);
      return descendants(root);
    }
    idx = buildIndex(root);
    rootIndexes.set(root, idx);
  }

  if (keys.length === 1) {
    const positions = bucket(idx, keys[0]!);
    const all = idx.all;
    const out: ElementNode[] = new Array(positions.length);
    for (let i = 0; i < positions.length; i++) out[i] = all[positions[i]!]!;
    return out;
  }

  const merged = new Set<number>();
  for (let i = 0; i < keys.length; i++) {
    const positions = bucket(idx, keys[i]!);
    for (let j = 0; j < positions.length; j++) merged.add(positions[j]!);
  }
  const sorted = [...merged].sort((a, b) => a - b);
  const all = idx.all;
  const out: ElementNode[] = new Array(sorted.length);
  for (let i = 0; i < sorted.length; i++) out[i] = all[sorted[i]!]!;
  return out;
}

export function querySelector(root: ElementNode, selector: string): ElementNode | null {
  return querySelectorAll(root, selector)[0] ?? null;
}
