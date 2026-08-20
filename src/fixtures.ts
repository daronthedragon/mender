import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ElementNode, parse } from "./html.js";

export interface Fixture {
  source: string;
  path: string;
  html: string;
}

export interface LoadedFixture extends Fixture {
  doc: ElementNode;
}

export function fixtureDir(root: string, name: string): string {
  return join(root, name);
}

export function listFixtures(root: string, name: string): Fixture[] {
  const dir = fixtureDir(root, name);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".html"))
    .sort()
    .map((f) => {
      const path = join(dir, f);
      return { source: f.replace(/\.html$/, ""), path, html: readFileSync(path, "utf8") };
    });
}

export function loadFixtures(root: string, name: string): LoadedFixture[] {
  return listFixtures(root, name).map((f) => ({ ...f, doc: parse(f.html) }));
}

/**
 * Fixtures are the regression gate: a repair has to keep working on every page
 * that used to work, which is what stops a "fix" that grabs whatever element
 * happens to satisfy the contract today.
 */
export function saveFixture(root: string, name: string, html: string, stamp: string): string {
  const dir = fixtureDir(root, name);
  mkdirSync(dir, { recursive: true });
  let path = join(dir, `${stamp}.html`);
  let n = 2;
  while (existsSync(path)) path = join(dir, `${stamp}-${n++}.html`);
  writeFileSync(path, html);
  return path;
}

export function todayStamp(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}
