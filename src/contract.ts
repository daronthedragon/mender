import type { ExtractedRow } from "./extract.js";
import type { ScraperSpec, Violation } from "./types.js";

/**
 * A contract asks "is this shaped like real data", not "did it throw". A scraper
 * that returns zero rows, an empty title or a price of 0 has broken just as
 * surely as one that crashed, and it is the silent kind that costs three weeks.
 */
export function validate(rows: ExtractedRow[], spec: ScraperSpec): Violation[] {
  const violations: Violation[] = [];
  const want = spec.expect?.rows;

  if (want?.min !== undefined && rows.length < want.min) {
    violations.push({
      code: "ROW_COUNT",
      detail: `expected at least ${want.min} rows, got ${rows.length}`,
    });
  }
  if (want?.max !== undefined && rows.length > want.max) {
    violations.push({
      code: "ROW_COUNT",
      detail: `expected at most ${want.max} rows, got ${rows.length}`,
    });
  }

  for (const row of rows) {
    for (const [name, field] of Object.entries(spec.fields)) {
      const got = row.fields[name];
      const value = got?.value ?? null;

      if (field.type === "list") {
        const items = Array.isArray(value) ? value : [];
        if (field.minItems !== undefined && items.length < field.minItems) {
          violations.push({
            code: "LIST_TOO_SHORT",
            field: name,
            row: row.index,
            detail: `expected at least ${field.minItems} items, got ${items.length}`,
          });
        } else if (field.required && items.length === 0) {
          violations.push({
            code: "FIELD_MISSING",
            field: name,
            row: row.index,
            detail: "list is empty",
          });
        }
        continue;
      }

      if (value === null) {
        if (field.required !== false) {
          // A number field that matched text but failed to parse is a different
          // failure from one that matched nothing at all.
          const matchedSomething = (got?.els.length ?? 0) > 0;
          violations.push({
            code: matchedSomething && field.type === "number" ? "FIELD_TYPE" : "FIELD_MISSING",
            field: name,
            row: row.index,
            detail: matchedSomething
              ? `matched an element but could not read a ${field.type} from ${JSON.stringify(got!.raw.slice(0, 60))}`
              : `selector ${JSON.stringify(field.selector)} matched nothing`,
          });
        }
        continue;
      }

      if (field.type === "number" && typeof value === "number") {
        if (field.min !== undefined && value < field.min) {
          violations.push({
            code: "FIELD_RANGE",
            field: name,
            row: row.index,
            detail: `${value} is below min ${field.min}`,
          });
        }
        if (field.max !== undefined && value > field.max) {
          violations.push({
            code: "FIELD_RANGE",
            field: name,
            row: row.index,
            detail: `${value} is above max ${field.max}`,
          });
        }
      }
    }
  }
  return violations;
}

/** Field names that failed, in spec order — the repair targets. */
export function brokenFields(violations: Violation[]): string[] {
  const seen = new Set<string>();
  for (const v of violations) if (v.field) seen.add(v.field);
  return [...seen];
}

export function rowCountBroken(violations: Violation[]): boolean {
  return violations.some((v) => v.code === "ROW_COUNT");
}
