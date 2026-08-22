import { type ElementNode, children, descendants, normText, parse } from "./html.js";
import { querySelectorAll } from "./select.js";
import { parseNumber } from "./extract.js";
import { repeatedGroups } from "./propose.js";
import { selectorsFor, stableClasses } from "./signature.js";
import { kindOf } from "./verify.js";
import type { FieldSpec, ScraperSpec } from "./types.js";

/**
 * Hand-authoring a spec is the real barrier to using any of this. Given a page,
 * this finds the repeating record, proposes fields for the values inside it, and
 * writes a spec that already passes — which the rest of the tool then defends.
 */

const MAX_FIELDS = 8;
const MIN_ROWS = 2;

/** Containers whose class legitimately names the items inside them. */
const LIST_CONTAINERS = new Set(["ul", "ol", "dl", "tbody", "table"]);

/** Regions that repeat like records but never contain any. */
const CHROME_TAGS = new Set(["nav", "footer", "header", "aside"]);
const CHROME_ROLES = new Set(["navigation", "contentinfo", "banner", "search", "complementary"]);
// "reference"/"references" are back: unlike "header" they are unambiguous, and
// dropping them let a Wikipedia article's footnote list beat its data table.
// Deliberately excludes "header" and "banner": a table carrying
// "sticky-header-multi" is not page chrome, and matching that token rejected
// every row of a Wikipedia data table. The <header>/<nav>/<footer>/<aside> tag
// check below covers real chrome without guessing from class names.
const CHROME_WORDS =
  /(^|[-_ ])(nav|navbar|navigation|menu|footer|sidebar|breadcrumb|pagination|reference|references|reflist|footnote|citation|cookie|social-share|share-buttons)([-_ ]|$)/i;

/**
 * Page furniture is structurally indistinguishable from records: a footer is
 * repeated sibling columns with text, a nav is repeated links, a reference list
 * is a long run of <li>. On a Wikipedia list article the reference list is
 * genuinely larger than the data table, so counting alone picks the wrong one.
 * Only the semantics separate them.
 */
export function inChrome(el: ElementNode): boolean {
  let cur: ElementNode | null = el;
  // Stops at <body>: a class on <body> or <html> describes the whole document,
  // not a region within it, so it can never say "this part is furniture".
  // Wikipedia ships `vector-feature-language-in-main-menu` on <html>, and
  // matching it vetoed every record on the page.
  while (cur && cur.tag !== "body" && cur.tag !== "html" && cur.tag !== "#document") {
    if (CHROME_TAGS.has(cur.tag)) return true;
    const role = cur.attrs["role"];
    if (role && CHROME_ROLES.has(role.toLowerCase())) return true;
    const cls = cur.attrs["class"] ?? "";
    const id = cur.attrs["id"] ?? "";
    if (CHROME_WORDS.test(cls) || CHROME_WORDS.test(id)) return true;
    cur = cur.parent;
  }
  return false;
}

function isValueElement(el: ElementNode): boolean {
  const text = normText(el);
  if (!text) return false;
  // A value lives on the element holding the text, not on a wrapper whose text
  // is merely the concatenation of its children.
  const childText = descendants(el)
    .map((d) => normText(d))
    .filter(Boolean);
  return childText.length === 0 || (childText.length === 1 && childText[0] === text);
}

function niceName(el: ElementNode, used: Set<string>, fallbackIndex: number): string {
  const parent = el.parent;
  const candidates = [
    el.attrs["data-testid"],
    el.attrs["data-test"],
    el.attrs["itemprop"],
    el.attrs["data-field"],
    ...stableClasses(el),
    // An <li> rarely carries a class, but the <ul> around it usually names the
    // whole thing: "features", "tags", "specs". Only genuine list containers
    // count — borrowing the name of a row wrapper would label a cell "row".
    ...(parent && LIST_CONTAINERS.has(parent.tag) ? stableClasses(parent) : []),
    ...(parent && LIST_CONTAINERS.has(parent.tag) && parent.attrs["itemprop"]
      ? [parent.attrs["itemprop"]]
      : []),
    el.tag === "h1" || el.tag === "h2" || el.tag === "h3" ? "title" : "",
  ].filter((c): c is string => Boolean(c));

  for (const raw of candidates) {
    const name = raw
      .replace(/[^a-zA-Z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .toLowerCase();
    if (name && name.length <= 30 && !used.has(name)) return name;
  }
  let n = `field_${fallbackIndex}`;
  let i = fallbackIndex;
  while (used.has(n)) n = `field_${++i}`;
  return n;
}

interface Column {
  selector: string;
  el: ElementNode;
  /** Non-empty values per row, exactly as extraction would produce them. */
  perRow: number[];
  /** What a scalar field would read: the first match in each row. */
  scalarTexts: string[];
  /** Every non-empty value, across all rows. */
  texts: string[];
  /** The exact elements matched, used to spot columns covering the same ground. */
  els: Set<ElementNode>;
}

function columnsFor(rows: ElementNode[]): Column[] {
  const bySelector = new Map<string, Column>();

  for (const row of rows) {
    for (const el of descendants(row)) {
      if (!isValueElement(el)) continue;
      for (const selector of selectorsFor(row, el).slice(0, 4)) {
        if (bySelector.has(selector)) continue;
        let perRow: number[];
        let texts: string[];
        let scalarTexts: string[];
        let els: Set<ElementNode>;
        try {
          const hits = rows.map((r) => querySelectorAll(r, selector));
          // Mirror extraction exactly, or the generated contract asserts things
          // the extractor will never produce. A list drops empty values; a
          // scalar reads ONLY the first match, which for `a` is often an image
          // link with no text at all.
          perRow = hits.map((h) => h.filter((e) => normText(e) !== "").length);
          texts = hits.flatMap((h) => h.map((e) => normText(e))).filter(Boolean);
          scalarTexts = hits.map((h) => (h[0] ? normText(h[0]) : ""));
          els = new Set(hits.flat());
        } catch {
          continue;
        }
        // A column has to exist in most rows to be worth naming.
        if (perRow.filter((n) => n > 0).length < Math.ceil(rows.length * 0.6)) continue;
        // And it has to vary. "Add to basket" on every row is furniture, not a
        // field, and naming it invites a contract that asserts a button label.
        if (rows.length > 2 && new Set(texts).size === 1) continue;
        // If this were taken as a scalar, extraction would read the first match
        // and find nothing. That is not a field, it is a mis-aimed selector.
        const scalarShaped = perRow.every((n) => n <= 1);
        if (scalarShaped && scalarTexts.filter(Boolean).length < Math.ceil(rows.length * 0.6)) {
          continue;
        }
        bySelector.set(selector, { selector, el, perRow, texts, scalarTexts, els });
      }
    }
  }
  return [...bySelector.values()];
}

function inferField(col: Column): FieldSpec {
  // A column is allowed to be absent from some records — real listings have
  // optional fields. But a bound computed from only the rows that HAVE it, then
  // asserted on every row, is a contract the page cannot satisfy. Whether the
  // column is universal decides what may be asserted about it at all.
  const universal = col.perRow.every((n) => n > 0);
  const scalar = col.perRow.every((n) => n <= 1);

  if (!scalar) {
    // minItems is checked unconditionally by the contract, so it can only be
    // stated when every record has the field.
    if (!universal) return { selector: col.selector, type: "list", required: false };
    return {
      selector: col.selector,
      type: "list",
      minItems: Math.max(1, Math.min(...col.perRow.filter((n) => n > 0))),
    };
  }

  // A scalar reads the first match, so judge the type from what that yields.
  const values = col.scalarTexts.filter(Boolean);
  const numeric =
    values.length > 0 &&
    values.every((t) => parseNumber(t) !== null) &&
    values.every((t) => ["currency", "numeric"].includes(kindOf(t)));

  if (numeric) {
    const numbers = values.map((t) => parseNumber(t)!).filter((n) => Number.isFinite(n));
    // A floor of zero on a field that has never been zero is a free contract.
    return Math.min(...numbers) > 0 && universal
      ? { selector: col.selector, type: "number", required: universal, min: 0 }
      : { selector: col.selector, type: "number", required: universal };
  }
  return { selector: col.selector, type: "string", required: universal };
}

/** Prefer columns that vary between rows: a constant is a label, not a value. */
function informationScore(col: Column): number {
  const distinct = new Set(col.texts).size;
  const variety = col.texts.length === 0 ? 0 : distinct / col.texts.length;
  const coverage = col.perRow.filter((n) => n > 0).length / col.perRow.length;
  const depth = col.selector.split(/[\s>]+/).length;
  return variety * 2 + coverage - depth * 0.2;
}

/** A selector that identifies its element by position rather than by meaning. */
function isPositional(selector: string): boolean {
  return selector.includes(":nth-child") || /^[a-z]+$/i.test(selector.trim());
}

/**
 * Named columns beat a bag of cells, and a bag of cells beats positional ones.
 *
 * Without this a table's generic "td" list wins on variety and swallows
 * ".price" and ".qty" as redundant; with it, the named cells are claimed first
 * and the "td" bag is dropped instead. The reverse case still works: a <ul> of
 * unclassed <li> has no named column, so the list is claimed and the
 * "li:nth-child(n)" duplicates are dropped.
 */
function tierOf(col: Column): number {
  const list = col.perRow.some((n) => n > 1);
  if (!list && !isPositional(col.selector)) return 0;
  if (list) return 1;
  return 2;
}

/** Is this element, or any ancestor up to the row, already claimed? */
function claimedWithin(claimed: Set<ElementNode>, el: ElementNode): boolean {
  let cur: ElementNode | null = el;
  while (cur) {
    if (claimed.has(cur)) return true;
    cur = cur.parent;
  }
  return false;
}

/**
 * Tables carry their own field names in the header row, and their cells are
 * addressed by position rather than by class. Treating them like a generic
 * record loses both: a Wikipedia table came back with one list field holding
 * ["City[a]", "Country", "UN 2025 population estimates[12]", …] — the header
 * row itself, captured as data.
 */
function headerCells(rows: ElementNode[]): string[] {
  const first = rows[0];
  if (!first || first.tag !== "tr") return [];

  // The header is either a row made entirely of <th>, or a <thead> above it.
  const ths = children(first).filter((c) => c.tag === "th");
  if (ths.length >= 2 && ths.length === children(first).length) {
    return ths.map((c) => normText(c));
  }

  let table: ElementNode | null = first.parent;
  while (table && table.tag !== "table") table = table.parent;
  if (!table) return [];
  const head = querySelectorAll(table, "thead th");
  return head.length >= 2 ? head.map((c) => normText(c)) : [];
}

/** "UN 2025 population estimates[12]" -> "un_2025_population_estimates" */
function headerName(text: string, used: Set<string>, index: number): string {
  const cleaned = text
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase()
    .slice(0, 30)
    .replace(/_+$/, "");
  if (cleaned && !used.has(cleaned) && !/^\d+$/.test(cleaned)) return cleaned;
  let n = `column_${index}`;
  let i = index;
  while (used.has(n)) n = `column_${++i}`;
  return n;
}

interface TableShape {
  rows: ElementNode[];
  fields: Record<string, FieldSpec>;
  /** Leading rows that carry no data cells, i.e. the header. */
  headerRows: number;
}

/**
 * Columns come from the DATA rows, not the header.
 *
 * A header can span two rows with colspan — a Wikipedia table has six header
 * cells above thirteen data columns — so mapping header index to cell position
 * puts every value in the wrong place, or in none. Positions are taken from the
 * data; the header is used only for naming, and only when the counts agree.
 */
function inferTable(rows: ElementNode[]): TableShape | null {
  const first = rows[0];
  if (!first || first.tag !== "tr") return null;

  const hasData = (r: ElementNode) => children(r).some((c) => c.tag === "td");
  let headerRows = 0;
  while (headerRows < rows.length && !hasData(rows[headerRows]!)) headerRows++;

  const dataRows = rows.slice(headerRows).filter(hasData);
  if (dataRows.length < MIN_ROWS || headerRows === 0) return null;

  const headers = headerCells(rows);
  const width = Math.max(...dataRows.map((r) => children(r).length));
  const named = headers.length === width;

  const fields: Record<string, FieldSpec> = {};
  const used = new Set<string>();

  for (let pos = 1; pos <= width && Object.keys(fields).length < MAX_FIELDS; pos++) {
    // A cell at a given position may be a <td> or a leading row-header <th>.
    let selector = "";
    let values: string[] = [];
    for (const tag of ["td", "th"]) {
      const candidate = `${tag}:nth-child(${pos})`;
      const got = dataRows.map((r) => {
        const cell = querySelectorAll(r, candidate)[0];
        return cell ? normText(cell) : "";
      });
      if (got.filter(Boolean).length > values.filter(Boolean).length) {
        selector = candidate;
        values = got;
      }
    }

    if (values.filter(Boolean).length < Math.ceil(dataRows.length * 0.6)) continue;
    if (dataRows.length > 2 && new Set(values.filter(Boolean)).size === 1) continue;

    const universal = values.every(Boolean);
    const nonEmpty = values.filter(Boolean);
    const numeric =
      nonEmpty.length > 0 &&
      nonEmpty.every((t) => parseNumber(t) !== null) &&
      nonEmpty.every((t) => ["currency", "numeric"].includes(kindOf(t)));

    const name = headerName(named ? (headers[pos - 1] ?? "") : "", used, pos);
    used.add(name);
    fields[name] = numeric
      ? { selector, type: "number", required: universal }
      : { selector, type: "string", required: universal };
  }

  return Object.keys(fields).length >= 2 ? { rows: dataRows, fields, headerRows } : null;
}

export interface InferenceResult {
  spec: ScraperSpec;
  rowCount: number;
  notes: string[];
}

/**
 * A page whose HTML is mostly script and almost no text has not been rendered
 * yet. Telling someone to "try a listing page" when they are already on one is
 * worse than saying nothing: crates.io serves 5KB containing 73 characters of
 * text, and the records only exist after JavaScript runs.
 */
export function looksClientRendered(html: string, doc: ElementNode): boolean {
  const text = normText(doc).length;
  if (!/<script/i.test(html)) return false;
  if (text < 200) return true;
  // A real page carries far more text than this relative to its markup.
  return html.length > 20_000 && text / html.length < 0.01;
}

export function inferSpec(html: string, url: string, name: string): InferenceResult | null {
  const doc = parse(html);
  const groups = repeatedGroups(doc, MIN_ROWS);
  if (groups.length === 0) return null;

  // The best record group carries the most distinct information, not merely the
  // most members: navigation lists repeat too.
  let best: { rows: ElementNode[]; selector: string; score: number } | null = null;
  for (const group of groups) {
    const sample = group.members[0]!;
    const rows = group.members;
    // Low, deliberately: text is concatenated without separators, so a real
    // table row like "Widget$4.5012" is only 13 characters. The valueCount
    // check below is what actually excludes navigation and decoration.
    const avgText = rows.map((r) => normText(r).length).reduce((a, b) => a + b, 0) / rows.length;
    if (avgText < 8) continue;

    const valueCount = descendants(sample).filter(isValueElement).length;
    if (valueCount < 2) continue;

    // Records do not live in a footer, a nav, or a reference list.
    if (inChrome(sample)) continue;

    for (const selector of selectorsFor(doc, sample).slice(0, 6)) {
      let hits: ElementNode[];
      try {
        hits = querySelectorAll(doc, selector);
      } catch {
        continue;
      }
      if (hits.length < MIN_ROWS) continue;
      const overshoot = Math.abs(hits.length - rows.length) / rows.length;
      const specificity = stableClasses(sample).length > 0 ? 1 : 0;

      // valueCount is capped: a record has a handful of fields, and rewarding it
      // without a ceiling makes an outer wrapper holding fifty values beat the
      // record it contains. On Hacker News that chose a nested table row over
      // the thirty stories.
      const density = Math.min(valueCount, 8) * 1.2;

      // More records is better evidence that this is the repeating unit. Log so
      // that 30 beats 4 decisively while 300 does not swamp everything else.
      const volume = Math.log2(hits.length) * 1.5;

      // "tr:nth-child(1)" names a position, not a kind of thing, and is almost
      // always a coincidence. A bare tag is different: "li" and "tr" are how
      // unclassed records are legitimately addressed, so it earns a nudge away
      // rather than a veto — penalising it equally made an <ol> wrapper beat
      // the <li> books inside it.
      const positional = selector.includes(":nth-child") ? 3 : isPositional(selector) ? 0.5 : 0;

      const score =
        density + volume + Math.min(avgText, 200) / 50 + specificity - overshoot * 3 - positional;
      if (!best || score > best.score) best = { rows: hits, selector, score };
    }
  }

  if (!best) return null;

  // Tables first: they name their own fields in the header row and address
  // cells by position, neither of which the generic column search can see.
  const table = inferTable(best.rows);
  if (table) {
    // The chosen selector matches the header row too, so narrow it to the data
    // rows or the header is extracted as a record.
    // The data rows must be isolable, or the header is extracted as a record
    // and every cell selector reports a violation. A <thead> means the data
    // rows start at position 1 inside <tbody>; a header row sitting among the
    // data rows means an nth-child offset. Try both, and verify by counting.
    const base = best.selector;
    const stripped = base.replace(/\s*>?\s*tr$/, "");
    const offset = table.headerRows + 1;
    let rowSelector = "";
    for (const candidate of [
      `${stripped} tbody tr`,
      `${base}:nth-child(n+${offset})`,
      `${stripped} tbody tr:nth-child(n+${offset})`,
    ]) {
      try {
        if (querySelectorAll(doc, candidate).length === table.rows.length) {
          rowSelector = candidate;
          break;
        }
      } catch {
        // an unparseable candidate is simply not used
      }
    }

    // No selector isolates the data rows, so the table path would emit a spec
    // that fails its own page. Fall through to the generic search instead.
    if (rowSelector) {
      const spec: ScraperSpec = {
        name,
        url,
        row: rowSelector,
        fields: table.fields,
        expect: {
          rows: {
            min: Math.max(1, Math.floor(table.rows.length / 2)),
            max: Math.ceil(table.rows.length * 2),
          },
        },
      };
      return {
        spec,
        rowCount: table.rows.length,
        notes: [
          `found a table with ${table.rows.length} data rows matching ${JSON.stringify(rowSelector)}`,
          `named ${Object.keys(table.fields).length} column(s) from the header: ${Object.keys(table.fields).join(", ")}`,
          "review the types and bounds before trusting it — a starting point, not an oracle",
        ],
      };
    }
  }

  const columns = columnsFor(best.rows)
    .filter((c) => c.texts.length > 0)
    .sort((a, b) => tierOf(a) - tierOf(b) || informationScore(b) - informationScore(a));

  const fields: Record<string, FieldSpec> = {};
  const used = new Set<string>();
  // One union of everything already claimed. Checking each claimed set
  // separately would miss a generic column that is covered by several fields
  // together rather than by any single one - a table's "td" bag is exactly that.
  const claimed = new Set<ElementNode>();
  let redundant = 0;

  for (const col of columns) {
    if (Object.keys(fields).length >= MAX_FIELDS) break;

    // A column whose elements are already covered by a field taken above is
    // noise, not data: once "li" is captured as a list, "li:nth-child(2)" adds
    // nothing but a second name for the same text. An element nested inside a
    // claimed one counts as covered too — the <a> inside a claimed <h3> is the
    // same title, addressed differently.
    let covered = col.els.size > 0;
    for (const el of col.els) {
      if (!claimedWithin(claimed, el)) {
        covered = false;
        break;
      }
    }
    if (covered) {
      redundant++;
      continue;
    }
    for (const el of col.els) claimed.add(el);

    const fieldName = niceName(col.el, used, Object.keys(fields).length + 1);
    used.add(fieldName);
    fields[fieldName] = inferField(col);
  }

  if (Object.keys(fields).length === 0) return null;

  const rowCount = best.rows.length;
  const spec: ScraperSpec = {
    name,
    url,
    row: best.selector,
    fields,
    expect: {
      rows: { min: Math.max(1, Math.floor(rowCount / 2)), max: Math.ceil(rowCount * 2) },
    },
  };

  const notes: string[] = [
    `found ${rowCount} repeating records matching ${JSON.stringify(best.selector)}`,
    `proposed ${Object.keys(fields).length} field(s): ${Object.keys(fields).join(", ")}`,
  ];
  if (redundant > 0) {
    notes.push(`dropped ${redundant} redundant column(s) already covered by a field above`);
  }
  const listFields = Object.entries(fields).filter(([, f]) => f.type === "list");
  if (listFields.length > 0) {
    notes.push(
      `${listFields.map(([n]) => n).join(", ")} matched several elements per record, so typed as list`,
    );
  }
  notes.push("review the types and bounds before trusting it — a starting point, not an oracle");

  return { spec, rowCount, notes };
}

/** Stable, human-editable JSON: field order follows insertion order. */
export function formatSpec(spec: ScraperSpec): string {
  return JSON.stringify(spec, null, 2) + "\n";
}
