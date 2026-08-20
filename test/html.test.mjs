import { eq, ok, section } from "./harness.mjs";
import { parse, normText, classList, descendants } from "../dist/html.js";
import { querySelectorAll } from "../dist/select.js";

section("html parser");

const t = (html, sel) => querySelectorAll(parse(html), sel);

// Unclosed <li> is legal HTML and extremely common in the wild.
{
  const items = t("<ul><li>a<li>b<li>c</ul>", "li");
  eq(items.length, 3, "implicit </li> closes the previous item");
  eq(normText(items[1]), "b", "implicitly closed items keep their own text");
}

// <p> is closed by the next block element.
{
  const ps = t("<div><p>one<p>two<div>three</div></div>", "p");
  eq(ps.length, 2, "implicit </p> before a following p");
  eq(normText(ps[0]), "one", "first paragraph does not swallow the second");
}

// A "<" inside a script is not markup. Getting this wrong invents elements.
{
  const found = t(`<div class="real">yes</div><script>var x = "<div class='real'>fake</div>";</script>`, ".real");
  eq(found.length, 1, "markup inside <script> is text, not elements");
  eq(normText(found[0]), "yes", "the real element is the one returned");
}

{
  const styled = t("<style>.a { content: '<b>' }</style><b>bold</b>", "b");
  eq(styled.length, 1, "markup inside <style> is text, not elements");
}

// Void elements never close, so they must not capture their siblings.
{
  const doc = parse("<div><img src=x><span>after</span></div>");
  const span = querySelectorAll(doc, "div > span");
  eq(span.length, 1, "void <img> does not become the parent of its siblings");
}

{
  const brs = t("<p>a<br>b<br/>c</p>", "br");
  eq(brs.length, 2, "both <br> and <br/> parse as void");
}

// Attribute quoting variants all appear in real pages.
{
  const doc = parse(`<a id=bare class="two words" data-x='single' disabled>link</a>`);
  const a = querySelectorAll(doc, "a")[0];
  eq(a.attrs.id, "bare", "unquoted attribute value");
  eq(a.attrs["data-x"], "single", "single-quoted attribute value");
  eq(a.attrs.disabled, "", "valueless attribute becomes empty string");
  eq(classList(a).join("|"), "two|words", "class list splits on whitespace");
}

// Entities.
{
  eq(normText(parse("<p>&copy; 2026 &mdash; a &amp; b</p>")), "© 2026 — a & b", "named entities decode");
  eq(normText(parse("<p>&#65;&#x42;</p>")), "AB", "numeric and hex entities decode");
  eq(normText(parse("<p>&notreal; stays</p>")), "&notreal; stays", "unknown entities are left alone");
}

// Comments and doctype are not content.
{
  const doc = parse("<!doctype html><!-- <div class=ghost></div> --><p>only</p>");
  eq(querySelectorAll(doc, ".ghost").length, 0, "elements inside comments do not exist");
  eq(normText(doc), "only", "comment text is not page text");
}

// Stray closing tags must not unwind the whole stack.
{
  const doc = parse("<div><span>a</span></b></div><p>after</p>");
  eq(querySelectorAll(doc, "p").length, 1, "a stray </b> does not destroy the tree");
}

// Table structure with implicit closes.
{
  const doc = parse("<table><tr><td>a<td>b<tr><td>c<td>d</table>");
  eq(querySelectorAll(doc, "tr").length, 2, "implicit </tr>");
  eq(querySelectorAll(doc, "td").length, 4, "implicit </td>");
  eq(normText(querySelectorAll(doc, "td")[3]), "d", "last cell text is its own");
}

// Nesting depth is preserved.
{
  const doc = parse("<div><div><div><span>deep</span></div></div></div>");
  ok(descendants(doc).length === 4, "four elements parsed");
  eq(querySelectorAll(doc, "div div div span").length, 1, "deep descendant path resolves");
}

// Text before any tag, and unterminated tags at EOF.
{
  // textContent semantics: adjacent text is concatenated without a separator,
  // which is why field selectors should name the leaf that holds the value.
  eq(normText(parse("bare text<p>then")), "bare textthen", "text nodes concatenate like textContent");
  eq(querySelectorAll(parse("<div><span>x"), "span").length, 1, "unterminated tags at EOF still parse");
}
