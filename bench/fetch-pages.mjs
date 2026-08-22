import { fetchPage } from "../dist/fetch.js";
import { writeFileSync } from "node:fs";
const sites = [
  ["hn","https://news.ycombinator.com"],
  ["lobsters","https://lobste.rs"],
  ["books","https://books.toscrape.com"],
  ["quotes","https://quotes.toscrape.com"],
  ["hockey","https://www.scrapethissite.com/pages/forms/"],
  ["countries","https://www.scrapethissite.com/pages/simple/"],
  ["elements","https://en.wikipedia.org/wiki/List_of_chemical_elements"],
  ["cities","https://en.wikipedia.org/wiki/List_of_largest_cities"],
  ["tlds","https://www.iana.org/domains/root/db"],
  ["openlibrary","https://openlibrary.org/trending/daily"],
  ["trending","https://github.com/trending"],
  ["slashdot","https://slashdot.org/"],
  ["laptops","https://webscraper.io/test-sites/e-commerce/static/computers/laptops"],
  ["lwn","https://lwn.net/"],
  ["goblog","https://go.dev/blog/"],
];
for (const [name,url] of sites) {
  const r = await fetchPage(url);
  if (r.status === 200 && r.html.length > 500) {
    writeFileSync(`bench/pages/${name}.html`, r.html);
    console.log(`  ${name.padEnd(12)} ${String(r.html.length).padStart(8)} bytes`);
  } else console.log(`  ${name.padEnd(12)} SKIP HTTP ${r.status}`);
}
