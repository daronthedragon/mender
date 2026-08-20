import { type ElementNode, children, descendants, normText } from "./html.js";
import { querySelectorAll } from "./select.js";
import { parseNumber, rowElements } from "./extract.js";
import {
  type Exemplar,
  type PathStep,
  STABLE_ATTRS,
  exemplarOf,
  groupSignature,
  jaccard,
  pathFrom,
  pathSimilarity,
  selectorsFor,
  shapeOf,
  stableClasses,
} from "./signature.js";
import type { Candidate, ScraperSpec } from "./types.js";

export const ROW_TARGET = "__row__";

export interface ProposalInput {
  spec: ScraperSpec;
  liveDoc: ElementNode;
  /** Snapshots that passed under the current spec. Empty means no reference. */
  goldenDocs: { source: string; doc: ElementNode }[];
  target: string;
  /** Row selector to use on the live page, if the row itself was repaired first. */
  liveRowSelector?: string;
}

const MAX_CANDIDATES = 15;

function modal<T>(values: T[], key: (v: T) => string): T | null {
  const counts = new Map<string, { n: number; v: T }>();
  for (const v of values) {
    const k = key(v);
    const hit = counts.get(k);
    if (hit) hit.n++;
    else counts.set(k, { n: 1, v });
  }
  let best: { n: number; v: T } | null = null;
  for (const entry of counts.values()) if (!best || entry.n > best.n) best = entry;
  return best?.v ?? null;
}

/* ---------- field proposals ---------- */

function learnFieldExemplars(
  spec: ScraperSpec,
  goldenDocs: { source: string; doc: ElementNode }[],
  field: string,
): Exemplar[] {
  const spec_ = spec.fields[field];
  if (!spec_) return [];
  const out: Exemplar[] = [];
  for (const g of goldenDocs) {
    for (const row of rowElements(g.doc, spec)) {
      for (const el of querySelectorAll(row, spec_.selector)) {
        out.push(exemplarOf(row, el));
      }
    }
  }
  return out;
}

/**
 * Everything about the exemplars that does not depend on the element being
 * scored, computed once.
 *
 * Scoring runs for every descendant of every row, so anything derived from the
 * exemplar set alone was previously recomputed (elements x exemplars) times:
 * three `modal` reductions and four linear `some` scans per element. Hoisting
 * them turns the per-element cost into hash lookups.
 */
interface ExemplarProfile {
  empty: boolean;
  tag: string;
  classes: string[];
  path: PathStep[];
  texts: Set<string>;
  shapes: Set<string>;
  /** Per stable attribute: the values seen, and whether any exemplar had it. */
  attrValues: Map<string, Set<string>>;
  firstTextLen: number;
}

function profileExemplars(exemplars: Exemplar[]): ExemplarProfile {
  if (exemplars.length === 0) {
    return {
      empty: true,
      tag: "",
      classes: [],
      path: [],
      texts: new Set(),
      shapes: new Set(),
      attrValues: new Map(),
      firstTextLen: 1,
    };
  }

  const texts = new Set<string>();
  const shapes = new Set<string>();
  const attrValues = new Map<string, Set<string>>();

  for (const e of exemplars) {
    if (e.text) texts.add(e.text);
    if (e.shape) shapes.add(e.shape);
    for (const a of STABLE_ATTRS) {
      const v = e.attrs[a];
      if (v === undefined) continue;
      let set = attrValues.get(a);
      if (!set) {
        set = new Set();
        attrValues.set(a, set);
      }
      set.add(v);
    }
  }

  return {
    empty: false,
    // `.sort()` mutates the exemplar's own class array, exactly as before —
    // done once here rather than once per scored element, same end state.
    tag: modal(exemplars, (e) => e.tag)?.tag ?? "",
    classes: modal(exemplars, (e) => e.classes.sort().join("."))?.classes ?? [],
    path: modal(exemplars, (e) => e.path.map((p) => p.tag).join("/"))?.path ?? [],
    texts,
    shapes,
    attrValues,
    firstTextLen: exemplars[0]!.text.length || 1,
  };
}

function scoreElement(el: ElementNode, row: ElementNode, profile: ExemplarProfile): number {
  if (profile.empty) return 0;
  const text = normText(el);
  if (!text && !STABLE_ATTRS.some((a) => el.attrs[a])) return 0;

  const shape = shapeOf(text);

  let score = 0;
  if (text !== "" && profile.texts.has(text)) score += 4;
  else if (shape !== "" && profile.shapes.has(shape)) score += 2.5;

  if (el.tag === profile.tag) score += 1;
  score += 2.5 * jaccard(stableClasses(el), profile.classes);
  score += 2.5 * pathSimilarity(pathFrom(row, el), profile.path);

  for (const a of STABLE_ATTRS) {
    const v = el.attrs[a];
    if (!v) continue;
    const seen = profile.attrValues.get(a);
    if (seen?.has(v)) score += 3.5;
    else if (seen) score += 1;
    break;
  }

  // Prefer the element that holds the value, not an ancestor that contains it.
  const limit = profile.firstTextLen * 3;
  if (text.length > limit) score -= Math.min(2.5, text.length / limit);
  if (descendants(el).length > 6) score -= 1;

  return score;
}

function proposeField(input: ProposalInput): Candidate[] {
  const { spec, liveDoc, goldenDocs, target } = input;
  const field = spec.fields[target];
  if (!field) return [];

  const exemplars = learnFieldExemplars(spec, goldenDocs, target);
  if (exemplars.length === 0) return [];
  const profile = profileExemplars(exemplars);

  const rowSelector = input.liveRowSelector ?? spec.row;
  const liveRows = rowSelector ? querySelectorAll(liveDoc, rowSelector) : [liveDoc];
  if (liveRows.length === 0) return [];

  // Per row, keep the best few elements and remember the selectors that address them.
  const selectorScores = new Map<string, { total: number; rows: Set<number> }>();

  liveRows.forEach((row, rowIndex) => {
    const scored = descendants(row)
      .map((el) => ({ el, score: scoreElement(el, row, profile) }))
      .filter((c) => c.score > 1.5)
      .filter((c) => {
        // A number field can only be satisfied by text that is a number.
        if (field.type !== "number") return true;
        return parseNumber(field.attr ? (c.el.attrs[field.attr] ?? "") : normText(c.el)) !== null;
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, 4);

    for (const { el, score } of scored) {
      for (const sel of selectorsFor(row, el)) {
        const hit = selectorScores.get(sel) ?? { total: 0, rows: new Set<number>() };
        hit.total += score;
        hit.rows.add(rowIndex);
        selectorScores.set(sel, hit);
      }
    }
  });

  const candidates: Candidate[] = [];
  for (const [selector, { total, rows }] of selectorScores) {
    const coverage = rows.size / liveRows.length;
    // A selector that fires many times per row is the wrong shape for a scalar.
    const perRow = liveRows.map((r) => {
      try {
        return querySelectorAll(r, selector).length;
      } catch {
        return 0;
      }
    });
    const noisy = field.type !== "list" && perRow.some((n) => n > 1);
    const avg = total / Math.max(1, rows.size);
    const score = (0.6 * Math.min(1, avg / 8) + 0.4 * coverage) * (noisy ? 0.5 : 1);
    candidates.push({
      target,
      selector,
      score,
      reason: `matched in ${rows.size}/${liveRows.length} rows${noisy ? ", multiple hits per row" : ""}`,
    });
  }

  return candidates.sort((a, b) => b.score - a.score).slice(0, MAX_CANDIDATES);
}

/* ---------- row proposals ---------- */

export interface RowGroup {
  parent: ElementNode;
  signature: string;
  members: ElementNode[];
}

/** Repeating sibling groups are what a row selector is always trying to name. */
export function repeatedGroups(doc: ElementNode, minSize: number): RowGroup[] {
  const groups: RowGroup[] = [];
  const consider = (parent: ElementNode) => {
    const kids = children(parent);
    if (kids.length < minSize) return;
    const bySig = new Map<string, ElementNode[]>();
    for (const k of kids) {
      const sig = groupSignature(k);
      const arr = bySig.get(sig);
      if (arr) arr.push(k);
      else bySig.set(sig, [k]);
    }
    for (const [signature, members] of bySig) {
      if (members.length >= minSize) groups.push({ parent, signature, members });
    }
  };
  consider(doc);
  for (const el of descendants(doc)) consider(el);
  return groups;
}

function proposeRow(input: ProposalInput): Candidate[] {
  const { spec, liveDoc, goldenDocs } = input;
  if (!spec.row) return [];

  const goldenRows: ElementNode[] = [];
  for (const g of goldenDocs) goldenRows.push(...querySelectorAll(g.doc, spec.row));
  if (goldenRows.length === 0) return [];

  const goldenSig = modal(goldenRows, (r) => groupSignature(r));
  const goldenTag = goldenSig?.tag ?? "";
  const goldenClasses = goldenSig ? stableClasses(goldenSig) : [];
  const goldenCount = goldenRows.length / Math.max(1, goldenDocs.length);
  const goldenShapes = new Set(goldenRows.map((r) => shapeOf(normText(r).slice(0, 60))));

  const minSize = Math.max(2, Math.min(goldenCount, spec.expect?.rows?.min ?? 2));
  const groups = repeatedGroups(liveDoc, minSize);

  const seen = new Map<string, Candidate>();
  for (const group of groups) {
    const sample = group.members[0]!;
    let score = 0;
    if (sample.tag === goldenTag) score += 1.5;
    score += 3 * jaccard(stableClasses(sample), goldenClasses);
    const countDelta = Math.abs(group.members.length - goldenCount) / Math.max(1, goldenCount);
    score += 2 * Math.max(0, 1 - countDelta);
    const shapeHits = group.members.filter((m) =>
      goldenShapes.has(shapeOf(normText(m).slice(0, 60))),
    ).length;
    score += 2 * (shapeHits / group.members.length);
    if (score <= 1) continue;

    for (const sel of selectorsFor(liveDoc, sample)) {
      let hits: number;
      try {
        hits = querySelectorAll(liveDoc, sel).length;
      } catch {
        continue;
      }
      if (hits < minSize) continue;
      const overshoot = Math.abs(hits - group.members.length) / group.members.length;
      const final = (score / 8.5) * Math.max(0.2, 1 - overshoot);
      const prev = seen.get(sel);
      if (!prev || prev.score < final) {
        seen.set(sel, {
          target: ROW_TARGET,
          selector: sel,
          score: final,
          reason: `repeating ${group.signature} group, ${hits} matches (golden had ${Math.round(goldenCount)})`,
        });
      }
    }
  }

  return [...seen.values()].sort((a, b) => b.score - a.score).slice(0, MAX_CANDIDATES);
}

export function propose(input: ProposalInput): Candidate[] {
  const out = input.target === ROW_TARGET ? proposeRow(input) : proposeField(input);
  return out.map((c) => ({ ...c, via: "heuristic" }));
}
