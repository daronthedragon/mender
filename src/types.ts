export type FieldType = "string" | "number" | "list";

export interface FieldSpec {
  /** CSS selector, evaluated relative to the row element. */
  selector: string;
  type: FieldType;
  required?: boolean;
  /** For `number`: minimum acceptable value. */
  min?: number;
  /** For `number`: maximum acceptable value. */
  max?: number;
  /** For `list`: minimum number of matched items. */
  minItems?: number;
  /** Read this attribute instead of the element's text. */
  attr?: string;
}

export interface ScraperSpec {
  name: string;
  url: string;
  /** Selector for the repeating element. Omit to treat the document as one row. */
  row?: string;
  fields: Record<string, FieldSpec>;
  expect?: { rows?: { min?: number; max?: number } };
}

/**
 * Why a run failed. Only LAYOUT_CHANGE is allowed to trigger selector repair —
 * rewriting selectors against a bot-check page would "fix" the scraper into
 * extracting captcha text and then report itself green.
 */
export type Cause =
  | "OK"
  | "HTTP_ERROR"
  | "REDIRECTED"
  | "BLOCKED"
  | "EMPTY"
  | "LAYOUT_CHANGE";

export interface Violation {
  code:
    | "ROW_COUNT"
    | "FIELD_MISSING"
    | "FIELD_TYPE"
    | "FIELD_RANGE"
    | "LIST_TOO_SHORT";
  field?: string;
  row?: number;
  detail: string;
}

export interface FetchResult {
  status: number;
  finalUrl: string;
  html: string;
  ms: number;
}

export type Cell = string | number | string[] | null;
export type Row = Record<string, Cell>;

export interface CheckResult {
  spec: ScraperSpec;
  fetched: FetchResult;
  rows: Row[];
  violations: Violation[];
  cause: Cause;
  causeDetail: string;
}

export interface Candidate {
  /** Which part of the spec this replaces: a field name, or "__row__". */
  target: string;
  selector: string;
  /** Heuristic confidence before verification, 0..1. */
  score: number;
  reason: string;
}

export interface VerifiedCandidate extends Candidate {
  /** The raw proposal, before it was unioned with the selector it replaces. */
  proposed: string;
  passes: { source: string; ok: boolean; detail: string }[];
  verified: boolean;
}
