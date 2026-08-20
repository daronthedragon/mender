import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
const dir = process.argv[2];
const f = readdirSync(dir).filter((x) => x.endsWith(".cpuprofile")).sort().pop();
const p = JSON.parse(readFileSync(join(dir, f), "utf8"));
const byId = new Map(p.nodes.map((n) => [n.id, n]));
const self = new Map();
for (let i = 0; i < p.samples.length; i++) {
  const dt = p.timeDeltas[i] ?? 0;
  const n = byId.get(p.samples[i]);
  if (!n) continue;
  const cf = n.callFrame;
  const key = `${cf.functionName || "(anon)"} @ ${(cf.url || "").split(/[\/]/).pop()}:${cf.lineNumber + 1}`;
  self.set(key, (self.get(key) ?? 0) + dt);
}
const total = [...self.values()].reduce((a, b) => a + b, 0);
[...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30)
  .forEach(([k, v]) => console.log(`${(v / 1000).toFixed(1).padStart(9)} ms  ${((v / total) * 100).toFixed(1).padStart(5)}%  ${k}`));
console.log(`total ${(total / 1000).toFixed(1)} ms`);
