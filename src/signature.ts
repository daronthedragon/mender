import { type ElementNode, classList, normText, siblingIndex } from "./html.js";

/** Attributes worth building a selector on, best first. */
export const STABLE_ATTRS = [
  "data-testid",
  "data-test",
  "data-test-id",
  "data-qa",
  "data-cy",
  "itemprop",
  "data-field",
  "name",
  "aria-label",
];

const DIGITS = /\d+/g;
const LETTERS = /[A-Za-z]+/g;
const SPACES = /\s+/g;

/**
 * Collapse text to a shape so a price can be recognised as a price even when
 * the number changed. "$1,299.00" -> "$#,#.#" and "Pro plan" -> "W W".
 */
export function shapeOf(text: string): string {
  return text
    .replace(DIGITS, "#")
    .replace(LETTERS, "W")
    .replace(SPACES, " ")
    .trim()
    .slice(0, 40);
}

const BUILD_PREFIX = /^(css|sc|jsx|emotion|styles?)[-_]/i;
const HAS_DIGIT = /\d/;
const HAS_LETTER = /[a-z]/i;
const SHORT_HASH = /^[a-z]{1,3}-[a-z0-9]{6,}$/i;

/*
 * A page reuses the same few dozen class names thousands of times and this is
 * asked about every one of them on every scoring pass, so the verdict is
 * memoised. It depends on nothing but the string.
 */
const hashedCache = new Map<string, boolean>();
/** A watcher runs for days across many pages, so the memo does not grow forever. */
const HASHED_CACHE_MAX = 20000;

/** Build-tool class names churn between deploys, so they make weak selectors. */
export function looksHashed(cls: string): boolean {
  const hit = hashedCache.get(cls);
  if (hit !== undefined) return hit;
  if (hashedCache.size >= HASHED_CACHE_MAX) hashedCache.clear();
  const verdict =
    BUILD_PREFIX.test(cls) ||
    (cls.length >= 8 && HAS_DIGIT.test(cls) && HAS_LETTER.test(cls) && !cls.includes("-")) ||
    SHORT_HASH.test(cls);
  hashedCache.set(cls, verdict);
  return verdict;
}

/**
 * A fresh array every call on purpose: callers sort and otherwise take
 * ownership of what they get back.
 */
export function stableClasses(el: ElementNode): string[] {
  const all = classList(el);
  if (all.length === 0) return [];
  const out: string[] = [];
  for (let i = 0; i < all.length; i++) {
    const c = all[i]!;
    if (!looksHashed(c)) out.push(c);
  }
  return out;
}

export function jaccard(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 1;
  const A = new Set(a);
  const B = new Set(b);
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  const union = A.size + B.size - inter;
  return union === 0 ? 0 : inter / union;
}

export interface PathStep {
  tag: string;
  nth: number;
}

/** Tag path from `root` (exclusive) down to `el` (inclusive). */
export function pathFrom(root: ElementNode, el: ElementNode): PathStep[] {
  const steps: PathStep[] = [];
  let cur: ElementNode | null = el;
  while (cur && cur !== root) {
    const parent: ElementNode | null = cur.parent;
    const nth = parent ? siblingIndex(cur) + 1 : 1;
    steps.push({ tag: cur.tag, nth });
    cur = parent;
  }
  steps.reverse();
  return steps;
}

/** How alike two paths are, weighted toward the leaf end where it matters. */
export function pathSimilarity(a: PathStep[], b: PathStep[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const n = Math.min(a.length, b.length);
  let score = 0;
  let weight = 0;
  for (let i = 0; i < n; i++) {
    const x = a[a.length - 1 - i]!;
    const y = b[b.length - 1 - i]!;
    const w = 1 / (i + 1);
    weight += w;
    if (x.tag === y.tag) score += w * (x.nth === y.nth ? 1 : 0.6);
  }
  const lengthPenalty = 1 - Math.abs(a.length - b.length) / Math.max(a.length, b.length);
  return weight === 0 ? 0 : (score / weight) * (0.7 + 0.3 * lengthPenalty);
}

export interface Exemplar {
  text: string;
  shape: string;
  tag: string;
  classes: string[];
  attrs: Record<string, string>;
  path: PathStep[];
}

export function exemplarOf(row: ElementNode, el: ElementNode): Exemplar {
  const attrs: Record<string, string> = {};
  for (const a of STABLE_ATTRS) {
    const v = el.attrs[a];
    if (v) attrs[a] = v;
  }
  const text = normText(el);
  return {
    text,
    shape: shapeOf(text),
    tag: el.tag,
    classes: stableClasses(el),
    attrs,
    path: pathFrom(row, el),
  };
}

function cssEscapeValue(v: string): string {
  return v.replace(/["\\]/g, "\\$&");
}

/**
 * Candidate selector strings addressing `el` from within `row`, most durable
 * first. These are proposals only — every one is verified before use.
 */
export function selectorsFor(row: ElementNode, el: ElementNode): string[] {
  const out: string[] = [];
  const push = (s: string) => {
    if (s && !out.includes(s)) out.push(s);
  };

  for (const a of STABLE_ATTRS) {
    const v = el.attrs[a];
    if (v) {
      push(`[${a}="${cssEscapeValue(v)}"]`);
      push(`${el.tag}[${a}="${cssEscapeValue(v)}"]`);
    }
  }

  const classes = stableClasses(el);
  for (const c of classes) {
    push(`.${c}`);
    push(`${el.tag}.${c}`);
  }
  for (let i = 0; i < classes.length; i++) {
    for (let j = i + 1; j < classes.length; j++) push(`.${classes[i]}.${classes[j]}`);
  }

  // Fall back to hashed classes only when nothing stable exists.
  if (classes.length === 0) {
    for (const c of classList(el)) push(`${el.tag}.${c}`);
  }

  const parent = el.parent;
  if (parent && parent !== row) {
    for (const pc of stableClasses(parent)) {
      for (const c of classes) push(`.${pc} .${c}`);
      push(`.${pc} > ${el.tag}`);
    }
  }

  push(el.tag);

  const path = pathFrom(row, el);
  if (path.length > 0 && path.length <= 5) {
    push(path.map((s) => `${s.tag}:nth-child(${s.nth})`).join(" > "));
    const leaf = path[path.length - 1]!;
    push(`${leaf.tag}:nth-child(${leaf.nth})`);
  }

  return out;
}

/** Signature used to spot repeating sibling groups, i.e. candidate rows. */
export function groupSignature(el: ElementNode): string {
  return `${el.tag}.${stableClasses(el).sort().join(".")}`;
}
