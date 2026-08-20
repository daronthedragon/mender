import { readdirSync } from "node:fs";
import { report } from "./harness.mjs";

const files = readdirSync(new URL(".", import.meta.url))
  .filter((f) => f.endsWith(".test.mjs"))
  .sort();

for (const f of files) {
  await import(new URL(f, import.meta.url).href);
}

process.exit(report() === 0 ? 0 : 1);
