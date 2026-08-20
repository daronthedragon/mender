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

function isNameStart(c: string): boolean {
  return /[a-zA-Z]/.test(c);
}

export function parse(html: string): ElementNode {
  const root: ElementNode = {
    type: "element",
    tag: "#document",
    attrs: {},
    children: [],
    parent: null,
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
      while (j < n && /[a-zA-Z0-9:-]/.test(html[j]!)) j++;
      const tag = html.slice(i + 2, j).toLowerCase();
      const end = html.indexOf(">", j);
      i = end === -1 ? n : end + 1;
      // Pop to the nearest matching open element; ignore strays.
      const idx = stack.map((e) => e.tag).lastIndexOf(tag);
      if (idx > 0) stack.length = idx;
      continue;
    }
    // Opening tag
    if (i + 1 < n && isNameStart(html[i + 1]!)) {
      let j = i + 1;
      while (j < n && /[a-zA-Z0-9:-]/.test(html[j]!)) j++;
      const tag = html.slice(i + 1, j).toLowerCase();
      const { attrs, next, selfClosing } = parseAttrs(html, j);
      i = next;

      while (stack.length > 1 && autoCloses(tag, top().tag)) stack.pop();

      const el: ElementNode = { type: "element", tag, attrs, children: [], parent: top() };
      top().children.push(el);

      if (VOID.has(tag) || selfClosing) continue;

      if (RAWTEXT.has(tag)) {
        const close = new RegExp(`</${tag}\s*>`, "i");
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
    while (i < n && /\s/.test(html[i]!)) i++;
    if (i >= n) break;
    if (html[i] === ">") { i++; break; }
    if (html[i] === "/" && html[i + 1] === ">") { selfClosing = true; i += 2; break; }
    if (html[i] === "/") { i++; continue; }

    const nameStart = i;
    while (i < n && !/[\s=>/]/.test(html[i]!)) i++;
    const name = html.slice(nameStart, i).toLowerCase();
    if (!name) { i++; continue; }

    while (i < n && /\s/.test(html[i]!)) i++;
    if (html[i] !== "=") { attrs[name] = ""; continue; }
    i++;
    while (i < n && /\s/.test(html[i]!)) i++;

    const q = html[i];
    if (q === '"' || q === "'") {
      const end = html.indexOf(q, i + 1);
      const stop = end === -1 ? n : end;
      attrs[name] = decodeEntities(html.slice(i + 1, stop));
      i = stop + 1;
    } else {
      const start = i;
      while (i < n && !/[\s>]/.test(html[i]!)) i++;
      attrs[name] = decodeEntities(html.slice(start, i));
    }
  }
  return { attrs, next: i, selfClosing };
}

/* ---------- tree helpers ---------- */

export function children(el: ElementNode): ElementNode[] {
  return el.children.filter((c): c is ElementNode => c.type === "element");
}

export function walk(el: ElementNode, fn: (e: ElementNode) => void): void {
  for (const c of el.children) {
    if (c.type === "element") {
      fn(c);
      walk(c, fn);
    }
  }
}

export function descendants(el: ElementNode): ElementNode[] {
  const out: ElementNode[] = [];
  walk(el, (e) => out.push(e));
  return out;
}

/** Visible text: raw-text element contents are excluded, whitespace collapsed. */
export function textOf(node: DomNode): string {
  if (node.type === "text") return node.text;
  if (RAWTEXT.has(node.tag)) return "";
  let out = "";
  for (const c of node.children) out += textOf(c);
  return out;
}

export function normText(node: DomNode): string {
  return textOf(node).replace(/\s+/g, " ").trim();
}

export function classList(el: ElementNode): string[] {
  const c = el.attrs["class"];
  return c ? c.split(/\s+/).filter(Boolean) : [];
}

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
