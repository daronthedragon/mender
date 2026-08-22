/**
 * Repair benchmark over real pages.
 *
 * For each page: infer a spec, archive the page as the fixture, then mutate the
 * page the way a redeploy would and ask mender to repair it. The verdict that
 * matters is not "did it repair" but "is the repaired data the SAME data" — a
 * repair that silently changes the values is the failure this project exists to
 * prevent, so that outcome is counted separately and loudly.
 */
import { readFileSync, readdirSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { inferSpec } from "../dist/init.js";
import { runCheck, runRepair } from "../dist/repair.js";

/**
 * Rename a class INSIDE class attributes only. Replacing the bare substring
 * across the document corrupts unrelated content - it turned the domain
 * "a.baez.link" into "a.baez.link-x" and made a correct repair look wrong.
 */
const renameClass = (html, from, to) =>
  html.replace(/class="([^"]*)"/g, (m, list) => {
    const parts = list.split(/\s+/);
    if (!parts.includes(from)) return m;
    return 'class="' + parts.map((p) => (p === from ? to : p)).join(" ") + '"';
  });

const firstClassField = (spec) => {
  for (const f of Object.values(spec.fields)) {
    const cls = /^\.([\w-]+)$/.exec(f.selector);
    if (cls) return cls[1];
  }
  return null;
};

const MUTATIONS = [
  [
    "row class renamed",
    (h, spec) => {
      const cls = /^\.([\w-]+)/.exec(spec.row ?? "")?.[1];
      return cls ? renameClass(h, cls, cls + "-v2") : null;
    },
  ],
  [
    "field class renamed",
    (h, spec) => {
      const cls = firstClassField(spec);
      return cls ? renameClass(h, cls, cls + "-x") : null;
    },
  ],
  [
    "class swapped for data-testid",
    (h, spec) => {
      const cls = firstClassField(spec);
      return cls ? h.split('class="' + cls + '"').join('data-testid="' + cls + '"') : null;
    },
  ],
  [
    "value wrapped in a span",
    (h, spec) => {
      const cls = firstClassField(spec);
      if (!cls) return null;
      // Match an opening tag carrying the class, then its text, without needing
      // a backreference: the closing tag is left untouched.
      const re = new RegExp('(class="[^"]*\\b' + cls + '\\b[^"]*"[^>]*>)([^<>]{2,})', "g");
      const out = h.replace(re, (m, open, text) => open + '<span class="val">' + text + "</span>");
      return out === h ? null : out;
    },
  ],
];

const PAGES = process.env.BENCH_PAGES ?? "bench/pages";
const WORK = process.env.BENCH_WORK ?? "bench/.work";

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const tally = { repaired: 0, refused: 0, wrong: 0, na: 0 };

for (const file of readdirSync(PAGES).filter((f) => f.endsWith(".html"))) {
  const name = file.replace(/\.html$/, "");
  const html = readFileSync(PAGES + "/" + file, "utf8");
  const inferred = inferSpec(html, "https://example.com/" + name, name);
  if (!inferred) {
    console.log(name.padEnd(12) + "(no spec inferred)");
    continue;
  }
  const spec = inferred.spec;

  const dir = WORK + "/" + name;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir + "/" + name, { recursive: true });
  writeFileSync(dir + "/" + name + "/2026-01-01.html", html);

  const before = (await runCheck(spec, { html })).rows;
  const marks = [];

  for (const [label, mutate] of MUTATIONS) {
    let broken = null;
    try {
      broken = mutate(html, spec);
    } catch {
      broken = null;
    }
    if (!broken || broken === html) {
      marks.push(label + ": n/a");
      tally.na++;
      continue;
    }
    // Only count a mutation that actually broke something.
    const check = await runCheck(spec, { html: broken });
    if (check.cause === "OK") {
      marks.push(label + ": n/a");
      tally.na++;
      continue;
    }

    const out = await runRepair(spec, { fixturesRoot: dir, html: broken });
    if (!out.patched) {
      marks.push(label + ": REFUSED");
      tally.refused++;
      continue;
    }
    const after = (await runCheck(out.patched, { html: broken })).rows;
    if (same(before, after)) {
      marks.push(label + ": ok");
      tally.repaired++;
    } else {
      marks.push(label + ": WRONG");
      tally.wrong++;
    }
  }
  console.log(name.padEnd(12) + marks.join("  |  "));
}

console.log(
  "\n  repaired: " + tally.repaired +
    "   refused: " + tally.refused +
    "   WRONG: " + tally.wrong +
    "   not-applicable: " + tally.na,
);
