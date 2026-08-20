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

/**
 * Credentials are named, never stored. The spec holds the NAME of an
 * environment variable; the value is resolved at fetch time. A spec file stays
 * safe to commit.
 */
export interface AuthSpec {
  /** Header name -> environment variable holding its value. */
  headerEnv?: Record<string, string>;
  /** Environment variable holding a full Cookie header value. */
  cookieEnv?: string;
  /** Environment variable names for HTTP basic auth. */
  basicEnv?: { user: string; pass: string };
}

export interface PaginateSpec {
  /** Selector for the next-page link. Its href is followed. */
  next?: string;
  /** URL pattern containing {page}, used instead of following links. */
  urlTemplate?: string;
  /** First page number for urlTemplate. Defaults to 1. */
  startPage?: number;
  /** Hard cap on pages fetched. Required: an uncapped crawler is a bug. */
  maxPages: number;
}

export interface RenderSpec {
  /** Wait for this selector before reading the page. */
  waitFor?: string;
  /** Extra settle time after load, in milliseconds. */
  waitMs?: number;
  engine?: "chromium" | "firefox" | "webkit";
}

export interface ScraperSpec {
  name: string;
  url: string;
  /** Selector for the repeating element. Omit to treat the document as one row. */
  row?: string;
  fields: Record<string, FieldSpec>;
  expect?: { rows?: { min?: number; max?: number } };
  auth?: AuthSpec;
  paginate?: PaginateSpec;
  /** Present means "this page needs a browser". Absent means plain fetch. */
  render?: RenderSpec;
  /** Where this scraper's rows are written. Overrides the global setting. */
  output?: import("./sink.js").OutputConfig;
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
  | "DISALLOWED"
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

export interface FetchedPages {
  /** The first page. Cause classification always judges this one. */
  primary: FetchResult;
  /** Every page fetched, including the first. */
  pages: FetchResult[];
}

export type Cell = string | number | string[] | null;
export type Row = Record<string, Cell>;

export interface CheckResult {
  spec: ScraperSpec;
  /** The first page. Cause classification always judges this one. */
  fetched: FetchResult;
  /** Every page fetched, including the first. */
  pages: FetchResult[];
  rows: Row[];
  violations: Violation[];
  cause: Cause;
  causeDetail: string;
  /** Meaning-level warnings. Never a trigger for automatic repair. */
  drift: import("./history.js").DriftFinding[];
}

export interface Candidate {
  /** Which part of the spec this replaces: a field name, or "__row__". */
  target: string;
  selector: string;
  /** Which proposer produced this: "heuristic", or a model name. */
  via?: string;
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
