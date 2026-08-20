import { type ElementNode, normText } from "./html.js";
import { querySelectorAll } from "./select.js";
import type { Cell, FieldSpec, Row, ScraperSpec } from "./types.js";

export interface ExtractedField {
  value: Cell;
  /** Elements the field selector matched, kept for repair to learn from. */
  els: ElementNode[];
  /** Raw text before type coercion, useful when a number fails to parse. */
  raw: string;
}

export interface ExtractedRow {
  el: ElementNode;
  index: number;
  fields: Record<string, ExtractedField>;
}

/**
 * Turn text into a number the way prices and counts appear in the wild.
 * "$1,299.00" -> 1299, "1 234,56 kr" -> 1234.56, "Free" -> null.
 */
export function parseNumber(text: string): number | null {
  const cleaned = text.replace(/[^\d.,\-]/g, "").trim();
  if (!cleaned) return null;

  let normalized = cleaned;
  const hasComma = cleaned.includes(",");
  const hasDot = cleaned.includes(".");

  if (hasComma && hasDot) {
    // Whichever separator appears last is the decimal point.
    normalized =
      cleaned.lastIndexOf(",") > cleaned.lastIndexOf(".")
        ? cleaned.replace(/\./g, "").replace(",", ".")
        : cleaned.replace(/,/g, "");
  } else if (hasComma) {
    // A comma followed by exactly three digits at the end is a thousands group.
    normalized = /,\d{3}(?!\d)/.test(cleaned)
      ? cleaned.replace(/,/g, "")
      : cleaned.replace(",", ".");
  }

  const n = Number.parseFloat(normalized);
  return Number.isFinite(n) ? n : null;
}

function readElement(el: ElementNode, field: FieldSpec): string {
  if (field.attr) return (el.attrs[field.attr] ?? "").trim();
  return normText(el);
}

function coerce(field: FieldSpec, els: ElementNode[]): { value: Cell; raw: string } {
  if (field.type === "list") {
    const items = els.map((e) => readElement(e, field)).filter((s) => s.length > 0);
    return { value: items, raw: items.join(" | ") };
  }
  const first = els[0];
  if (!first) return { value: null, raw: "" };
  const raw = readElement(first, field);
  if (field.type === "number") return { value: parseNumber(raw), raw };
  return { value: raw === "" ? null : raw, raw };
}

/** Row elements for a spec. With no `row` selector the document is a single row. */
export function rowElements(doc: ElementNode, spec: ScraperSpec): ElementNode[] {
  if (!spec.row) return [doc];
  return querySelectorAll(doc, spec.row);
}

export function extract(doc: ElementNode, spec: ScraperSpec): ExtractedRow[] {
  return rowElements(doc, spec).map((el, index) => {
    const fields: Record<string, ExtractedField> = {};
    for (const [name, field] of Object.entries(spec.fields)) {
      const els = querySelectorAll(el, field.selector);
      const { value, raw } = coerce(field, els);
      fields[name] = { value, els, raw };
    }
    return { el, index, fields };
  });
}

export function toRows(extracted: ExtractedRow[]): Row[] {
  return extracted.map((r) => {
    const out: Row = {};
    for (const [name, f] of Object.entries(r.fields)) out[name] = f.value;
    return out;
  });
}
