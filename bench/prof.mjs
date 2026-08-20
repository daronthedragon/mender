import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generatePage, BENCH_SPEC } from "./gen.mjs";
const { runRepair } = await import("../dist/repair.js");
const broken = generatePage({ rows: 200, fields: 12, seed: 7, priceClass: "price-value" });
const fixRoot = join(tmpdir(), "mender-prof-fixtures");
rmSync(fixRoot, { recursive: true, force: true });
mkdirSync(join(fixRoot, "bench"), { recursive: true });
for (let i = 0; i < 3; i++)
  writeFileSync(join(fixRoot, "bench", `2026-0${i + 1}-01.html`), generatePage({ rows: 200, fields: 12, seed: 7 + i }));
for (let i = 0; i < 8; i++) await runRepair(BENCH_SPEC, { fixturesRoot: fixRoot, html: broken });
rmSync(fixRoot, { recursive: true, force: true });
