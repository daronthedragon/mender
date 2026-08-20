import { eq, ok, section } from "./harness.mjs";
import { parse, normText } from "../dist/html.js";
import { querySelectorAll, matches, SelectorError } from "../dist/select.js";

section("selector engine");

const PAGE = parse(`
<main id="root">
  <section class="grid wide">
    <div class="card featured" data-testid="card-1"><h3>One</h3><p class="amt">$19</p></div>
    <div class="card" data-testid="card-2"><h3>Two</h3><p class="amt">$49</p></div>
    <div class="card" data-testid="card-3"><h3>Three</h3><p class="amt">$99</p></div>
  </section>
  <aside class="card">Not a plan</aside>
</main>`);

const sel = (s) => querySelectorAll(PAGE, s);
const texts = (s) => sel(s).map(normText).join(",");

eq(sel(".card").length, 4, "class selector matches every element with the class");
eq(sel("div.card").length, 3, "tag plus class narrows to divs");
eq(sel(".card.featured").length, 1, "compound class selector");
eq(sel("#root").length, 1, "id selector");
eq(texts("h3"), "One,Two,Three", "tag selector, document order");

eq(sel("[data-testid]").length, 3, "attribute presence");
eq(texts('[data-testid="card-2"] h3'), "Two", "attribute equality plus descendant");
eq(sel('[data-testid^="card"]').length, 3, "attribute prefix operator");
eq(sel('[data-testid$="-3"]').length, 1, "attribute suffix operator");
eq(sel('[data-testid*="rd-"]').length, 3, "attribute contains operator");
eq(sel('[class~="featured"]').length, 1, "attribute whitespace-list operator");

eq(sel("section .amt").length, 3, "descendant combinator");
eq(sel("section > div").length, 3, "child combinator");
eq(sel("section > .amt").length, 0, "child combinator does not skip a level");
eq(texts("h3 + .amt"), "$19,$49,$99", "adjacent sibling combinator");
eq(texts(".grid ~ aside"), "Not a plan", "general sibling combinator");

eq(texts("div.card:first-child h3"), "One", ":first-child");
eq(texts("div.card:nth-child(2) h3"), "Two", ":nth-child(n)");
eq(texts("div.card:nth-child(odd) h3"), "One,Three", ":nth-child(odd)");
eq(sel("div.card:not(.featured)").length, 2, ":not() excludes");
eq(sel("h3, .amt").length, 6, "selector groups union their matches");
eq(sel("*").length > 8, true, "universal selector matches everything");

// Unknown pseudo-classes must not silently drop real matches.
eq(sel("div.card:hover").length, 3, "unknown pseudo-classes do not exclude");

// Scoping: a selector run inside a row cannot climb out of that row.
{
  const card = sel('[data-testid="card-2"]')[0];
  eq(querySelectorAll(card, ".amt").length, 1, "scoped query sees only its own subtree");
  eq(querySelectorAll(card, ".grid .amt").length, 0, "a scoped query cannot reach an ancestor to satisfy itself");
}

eq(matches(sel("aside")[0], ".card"), true, "matches() on a single element");
eq(matches(sel("aside")[0], "div.card"), false, "matches() respects the tag");

// Malformed selectors must fail loudly rather than silently matching nothing.
{
  let threw = false;
  try {
    querySelectorAll(PAGE, "div[unclosed");
  } catch (e) {
    threw = e instanceof SelectorError;
  }
  ok(threw, "an unparseable selector raises SelectorError");
}
