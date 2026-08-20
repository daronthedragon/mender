import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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

/* ---------- retirement ---------- */

export function fixtureDate(source: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(source);
  if (!m) return null;
  const d = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function ageInDays(source: string, now: Date): number | null {
  const d = fixtureDate(source);
  if (!d) return null;
  return Math.floor((now.getTime() - d.getTime()) / 86_400_000);
}

export interface RetirementOptions {
  /** A failing fixture older than this is retired rather than trusted. */
  maxAgeDays?: number;
  /** Keep at most this many fixtures, newest first. */
  keep?: number;
  now?: Date;
}

export interface Retirement {
  source: string;
  path: string;
  reason: string;
}

/**
 * Fixtures rot. A snapshot from eighteen months ago will eventually fail the
 * current spec for entirely legitimate reasons, and once it does it blocks
 * every future repair. The policy retires the ones that have stopped being a
 * useful reference — but never the last passing one, because a repair with no
 * reference is exactly what the regression gate exists to prevent.
 */
export function retirementPlan(
  fixtures: { source: string; path: string }[],
  passing: (source: string) => boolean,
  opts: RetirementOptions = {},
): Retirement[] {
  const now = opts.now ?? new Date();
  const maxAgeDays = opts.maxAgeDays ?? 180;
  const keep = opts.keep ?? 10;

  const sorted = [...fixtures].sort((a, b) => b.source.localeCompare(a.source));
  const survivors = new Set(sorted.map((f) => f.source));
  const out: Retirement[] = [];

  const passingCount = () => [...survivors].filter(passing).length;
  const retire = (f: { source: string; path: string }, reason: string) => {
    if (passing(f.source) && passingCount() <= 1) return; // never drop the last reference
    survivors.delete(f.source);
    out.push({ source: f.source, path: f.path, reason });
  };

  for (const f of [...sorted].reverse()) {
    if (passing(f.source)) continue;
    const age = ageInDays(f.source, now);
    if (age !== null && age > maxAgeDays) {
      retire(f, `fails the current spec and is ${age} days old`);
    }
  }

  for (const f of [...sorted].reverse()) {
    if (!survivors.has(f.source)) continue;
    if (survivors.size <= keep) break;
    retire(f, `over the keep limit of ${keep}`);
  }

  return out;
}

export function retire(plan: Retirement[]): number {
  for (const r of plan) rmSync(r.path, { force: true });
  return plan.length;
}
