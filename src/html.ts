/**
 * A tolerant HTML parser. Real pages are malformed in predictable ways, so this
 * handles the hazards that actually bite: raw-text elements whose contents look
 * like markup, void elements that never close, and tags the spec lets you leave
 * open (<li>, <p>, <tr>, <td>, <option>).
 *
 * Zero dependencies is a constraint of this project, not an accident.
 */

export interface ElementNode {
  type: "element";
  tag: string;
  attrs: Record<string, string>;
  children: DomNode[];
  parent: ElementNode | null;

  /*
   * Derived views of the tree, filled in on first use and never invalidated.
   * The parser is the only thing that ever builds a tree and nothing mutates
   * one afterwards, so a cached answer cannot go stale. Repair asks the same
   * questions about the same nodes thousands of times, which is what makes the
   * memory worth spending. Treat everything below as private to this module;
   * the arrays handed back are shared, so callers must not mutate them.
   */

  /** @internal Element children, in order. */
  _kids?: ElementNode[];
  /** @internal Every element in the subtree, document order. */
  _desc?: ElementNode[];
  /** @internal 0-based position among the parent's element children. */
  _eidx?: number;
  /** @internal How many element children this node has. Kept by the parser. */
  _nkids?: number;
  /** @internal textOf() result. */
  _text?: string;
  /** @internal normText() result. */
  _ntext?: string;
  /** @internal Parsed class attribute. */
  _classes?: string[];
}

export interface TextNode {
  type: "text";
  text: string;
  parent: ElementNode | null;
}

export type DomNode = ElementNode | TextNode;

const VOID = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "param", "source", "track", "wbr",
]);

/** Contents are text, never markup — a `<` inside <script> is not a tag. */
const RAWTEXT = new Set(["script", "style", "textarea", "title"]);

const P_CLOSERS = new Set([
  "address", "article", "aside", "blockquote", "div", "dl", "fieldset",
  "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr",
  "main", "nav", "ol", "p", "pre", "section", "table", "ul",
]);

/** Opening the key auto-closes any of the values still open above it. */
function autoCloses(open: string, stackTop: string): boolean {
  switch (open) {
    case "li":
      return stackTop === "li";
    case "dt":
    case "dd":
      return stackTop === "dt" || stackTop === "dd";
    case "option":
      return stackTop === "option";
    case "tr":
      return stackTop === "tr" || stackTop === "td" || stackTop === "th";
    case "td":
    case "th":
      return stackTop === "td" || stackTop === "th";
    case "thead":
    case "tbody":
    case "tfoot":
      return ["thead", "tbody", "tfoot", "tr", "td", "th"].includes(stackTop);
    default:
      return stackTop === "p" && P_CLOSERS.has(open);
  }
}

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  copy: "©", reg: "®", hellip: "…", mdash: "—",
  ndash: "–", rsquo: "’", lsquo: "‘", ldquo: "“",
  rdquo: "”", eur: "€", pound: "£", yen: "¥",
};

export function decodeEntities(s: string): string {
  if (!s.includes("&")) return s;
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, body: string) => {
    if (body[0] === "#") {
      const code =
        body[1] === "x" || body[1] === "X"
          ? parseInt(body.slice(2), 16)
          : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : m;
    }
    const hit = ENTITIES[body.toLowerCase()];
    return hit === undefined ? m : hit;
  });
}

/*
 * The scanners below are character-code predicates rather than per-character
 * regex tests. They mean exactly what the regexes they replaced meant — the
 * whitespace set is the full ECMAScript \s, not just ASCII — but a `.test()`
 * call per character of the document was the dominant cost of parsing.
 */

/** /[a-zA-Z]/ */
function isAlphaCode(c: number): boolean {
  return (c >= 97 && c <= 122) || (c >= 65 && c <= 90);
}

/** /[a-zA-Z0-9:-]/ — the characters a tag name may contain. */
function isTagNameCode(c: number): boolean {
  return (
    (c >= 97 && c <= 122) ||
    (c >= 65 && c <= 90) ||
    (c >= 48 && c <= 57) ||
    c === 58 /* : */ ||
    c === 45 /* - */
  );
}

/** /\s/ — every code point ECMAScript treats as whitespace. */
function isSpaceCode(c: number): boolean {
  if (c === 32 || (c >= 9 && c <= 13)) return true;
  if (c < 0xa0) return false;
  return (
    c === 0xa0 ||
    c === 0x1680 ||
    (c >= 0x2000 && c <= 0x200a) ||
    c === 0x2028 ||
    c === 0x2029 ||
    c === 0x202f ||
    c === 0x205f ||
    c === 0x3000 ||
    c === 0xfeff
  );
}

/** One compiled close-tag matcher per raw-text element, built once. */
const RAWTEXT_CLOSE = new Map<string, RegExp>();
for (const tag of RAWTEXT) RAWTEXT_CLOSE.set(tag, new RegExp(`</${tag}\s*>`, "i"));

export function parse(html: string): ElementNode {
  const root: ElementNode = {
    type: "element",
    tag: "#document",
    attrs: {},
    children: [],
    parent: null,
    _kids: undefined,
    _desc: undefined,
    _eidx: 0,
    _nkids: 0,
    _text: undefined,
    _ntext: undefined,
    _classes: undefined,
  };
  const stack: ElementNode[] = [root];
  const top = () => stack[stack.length - 1]!;

  let i = 0;
  const n = html.length;

  const pushText = (raw: string) => {
    if (!raw) return;
    const node: TextNode = { type: "text", text: decodeEntities(raw), parent: top() };
    top().children.push(node);
  };

  while (i < n) {
    const lt = html.indexOf("<", i);
    if (lt === -1) {
      pushText(html.slice(i));
      break;
    }
    if (lt > i) pushText(html.slice(i, lt));
    i = lt;

    // Comment
    if (html.startsWith("<!--", i)) {
      const end = html.indexOf("-->", i + 4);
      i = end === -1 ? n : end + 3;
      continue;
    }
    // Doctype / processing instruction
    if (html.startsWith("<!", i) || html.startsWith("<?", i)) {
      const end = html.indexOf(">", i);
      i = end === -1 ? n : end + 1;
      continue;
    }
    // Closing tag
    if (html.startsWith("</", i)) {
      let j = i + 2;
      while (j < n && isTagNameCode(html.charCodeAt(j))) j++;
      const tag = html.slice(i + 2, j).toLowerCase();
      const end = html.indexOf(">", j);
      i = end === -1 ? n : end + 1;
      // Pop to the nearest matching open element; ignore strays.
      let idx = -1;
      for (let k = stack.length - 1; k >= 0; k--) {
        if (stack[k]!.tag === tag) { idx = k; break; }
      }
      if (idx > 0) stack.length = idx;
      continue;
    }
    // Opening tag
    if (i + 1 < n && isAlphaCode(html.charCodeAt(i + 1))) {
      let j = i + 1;
      while (j < n && isTagNameCode(html.charCodeAt(j))) j++;
      const tag = html.slice(i + 1, j).toLowerCase();
      const { attrs, next, selfClosing } = parseAttrs(html, j);
      i = next;

      while (stack.length > 1 && autoCloses(tag, top().tag)) stack.pop();

      const parent = top();
      const el: ElementNode = {
        type: "element",
        tag,
        attrs,
        children: [],
        parent,
        _kids: undefined,
        _desc: undefined,
        _eidx: parent._nkids!,
        _nkids: 0,
        _text: undefined,
        _ntext: undefined,
        _classes: undefined,
      };
      parent._nkids!++;
      parent.children.push(el);

      if (VOID.has(tag) || selfClosing) continue;

      if (RAWTEXT.has(tag)) {
        const close = RAWTEXT_CLOSE.get(tag)!;
        const rest = html.slice(i);
        const m = close.exec(rest);
        const body = m ? rest.slice(0, m.index) : rest;
        if (body) el.children.push({ type: "text", text: body, parent: el });
        i += m ? m.index + m[0].length : rest.length;
        continue;
      }
      stack.push(el);
      continue;
    }
    // A bare "<" that starts nothing — treat as text.
    pushText("<");
    i++;
  }
  return root;
}

function parseAttrs(
  html: string,
  from: number,
): { attrs: Record<string, string>; next: number; selfClosing: boolean } {
  const attrs: Record<string, string> = {};
  let i = from;
  let selfClosing = false;
  const n = html.length;

  while (i < n) {
    while (i < n && isSpaceCode(html.charCodeAt(i))) i++;
    if (i >= n) break;
    let c = html.charCodeAt(i);
    if (c === 62 /* > */) { i++; break; }
    if (c === 47 /* / */) {
      if (html.charCodeAt(i + 1) === 62) { selfClosing = true; i += 2; break; }
      i++;
      continue;
    }

    const nameStart = i;
    // Name runs until whitespace, "=", ">" or "/".
    while (i < n) {
      c = html.charCodeAt(i);
      if (c === 61 || c === 62 || c === 47 || isSpaceCode(c)) break;
      i++;
    }
    const name = html.slice(nameStart, i).toLowerCase();
    if (!name) { i++; continue; }

    while (i < n && isSpaceCode(html.charCodeAt(i))) i++;
    if (html.charCodeAt(i) !== 61 /* = */) { attrs[name] = ""; continue; }
    i++;
    while (i < n && isSpaceCode(html.charCodeAt(i))) i++;

    const q = html[i];
    if (q === '"' || q === "'") {
      const end = html.indexOf(q, i + 1);
      const stop = end === -1 ? n : end;
      attrs[name] = decodeEntities(html.slice(i + 1, stop));
      i = stop + 1;
    } else {
      const start = i;
      while (i < n) {
        c = html.charCodeAt(i);
        if (c === 62 /* > */ || isSpaceCode(c)) break;
        i++;
      }
      attrs[name] = decodeEntities(html.slice(start, i));
    }
  }
  return { attrs, next: i, selfClosing };
}

/* ---------- tree helpers ---------- */

/** Element children. The returned array is cached and shared — do not mutate it. */
export function children(el: ElementNode): ElementNode[] {
  let kids = el._kids;
  if (kids !== undefined) return kids;
  kids = [];
  const cs = el.children;
  for (let i = 0; i < cs.length; i++) {
    const c = cs[i]!;
    if (c.type === "element") kids.push(c);
  }
  el._kids = kids;
  return kids;
}

/** 0-based position among the parent's element children. */
export function siblingIndex(el: ElementNode): number {
  const idx = el._eidx;
  if (idx !== undefined) return idx;
  const parent = el.parent;
  return parent ? children(parent).indexOf(el) : 0;
}

/** How many element children a node has. */
export function childElementCount(el: ElementNode): number {
  const n = el._nkids;
  return n !== undefined ? n : children(el).length;
}

export function walk(el: ElementNode, fn: (e: ElementNode) => void): void {
  const cached = el._desc;
  if (cached !== undefined) {
    for (let i = 0; i < cached.length; i++) fn(cached[i]!);
    return;
  }
  const cs = el.children;
  for (let i = 0; i < cs.length; i++) {
    const c = cs[i]!;
    if (c.type === "element") {
      fn(c);
      walk(c, fn);
    }
  }
}

function collect(el: ElementNode, out: ElementNode[]): void {
  const cs = el.children;
  for (let i = 0; i < cs.length; i++) {
    const c = cs[i]!;
    if (c.type !== "element") continue;
    out.push(c);
    const sub = c._desc;
    if (sub !== undefined) {
      for (let j = 0; j < sub.length; j++) out.push(sub[j]!);
    } else {
      collect(c, out);
    }
  }
}

/**
 * Every element in the subtree, document order. The array is cached and shared
 * — do not mutate it. Repair walks the same subtrees thousands of times, so
 * rebuilding this list per call was the single largest allocation source.
 */
export function descendants(el: ElementNode): ElementNode[] {
  let out = el._desc;
  if (out !== undefined) return out;
  out = [];
  collect(el, out);
  el._desc = out;
  return out;
}

const WS_RUN = /\s+/g;
const WS_SPLIT = /\s+/;

/** Visible text: raw-text element contents are excluded, whitespace collapsed. */
export function textOf(node: DomNode): string {
  if (node.type === "text") return node.text;
  if (RAWTEXT.has(node.tag)) return "";
  const hit = node._text;
  if (hit !== undefined) return hit;
  let out = "";
  const cs = node.children;
  for (let i = 0; i < cs.length; i++) out += textOf(cs[i]!);
  node._text = out;
  return out;
}

export function normText(node: DomNode): string {
  if (node.type === "text") return node.text.replace(WS_RUN, " ").trim();
  const hit = node._ntext;
  if (hit !== undefined) return hit;
  const out = textOf(node).replace(WS_RUN, " ").trim();
  node._ntext = out;
  return out;
}

/** The class attribute, split. The returned array is cached — do not mutate it. */
export function classList(el: ElementNode): string[] {
  const hit = el._classes;
  if (hit !== undefined) return hit;
  const raw = el.attrs["class"];
  const out = raw ? raw.split(WS_SPLIT).filter(Boolean) : EMPTY_CLASSES;
  el._classes = out;
  return out;
}

const EMPTY_CLASSES: string[] = [];

const NEEDS_ESCAPE = /[&<>"]/g;
const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };

function escapeHtml(s: string): string {
  return s.replace(NEEDS_ESCAPE, (c) => ESCAPES[c]!);
}

export interface SerializeOptions {
  /** Stop descending past this depth, replacing deeper content with a marker. */
  maxDepth?: number;
  /** Truncate any single text node longer than this. */
  maxText?: number;
  /** Drop these attributes entirely (inline styles and event handlers are noise). */
  dropAttrs?: (name: string) => boolean;
}

const DEFAULT_DROP = (name: string) =>
  name === "style" || name.startsWith("on") || name === "srcset" || name === "sizes";

/**
 * Render an element back to HTML. Used to show a model the markup around a
 * value without shipping it a megabyte of minified page.
 */
export function serialize(node: DomNode, opts: SerializeOptions = {}, depth = 0): string {
  const maxDepth = opts.maxDepth ?? 6;
  const maxText = opts.maxText ?? 200;
  const drop = opts.dropAttrs ?? DEFAULT_DROP;

  if (node.type === "text") {
    const t = node.text.replace(/\s+/g, " ");
    if (!t.trim()) return "";
    return escapeHtml(t.length > maxText ? t.slice(0, maxText) + "…" : t);
  }
  if (node.tag === "#document") {
    return node.children.map((c) => serialize(c, opts, depth)).join("");
  }
  if (RAWTEXT.has(node.tag)) return "";

  const attrs = Object.entries(node.attrs)
    .filter(([k]) => !drop(k))
    .map(([k, v]) => (v === "" ? ` ${k}` : ` ${k}="${escapeHtml(v)}"`))
    .join("");

  if (VOID.has(node.tag)) return `<${node.tag}${attrs}>`;
  if (depth >= maxDepth) {
    const inner = normText(node);
    return `<${node.tag}${attrs}>${escapeHtml(inner.slice(0, maxText))}</${node.tag}>`;
  }

  const inner = node.children.map((c) => serialize(c, opts, depth + 1)).join("");
  return `<${node.tag}${attrs}>${inner}</${node.tag}>`;
}
