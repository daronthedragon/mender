import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import type { FieldSpec, ScraperSpec } from "./types.js";

export class ConfigError extends Error {}

const FIELD_TYPES = new Set(["string", "number", "list"]);

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new ConfigError(msg);
}

export function validateSpec(raw: unknown, source: string): ScraperSpec {
  assert(raw && typeof raw === "object", `${source}: expected an object`);
  const o = raw as Record<string, unknown>;

  assert(typeof o["name"] === "string" && o["name"], `${source}: "name" must be a non-empty string`);
  assert(typeof o["url"] === "string" && o["url"], `${source}: "url" must be a non-empty string`);
  try {
    new URL(o["url"] as string);
  } catch {
    throw new ConfigError(`${source}: "url" is not a valid URL`);
  }
  assert(o["row"] === undefined || typeof o["row"] === "string", `${source}: "row" must be a string`);
  assert(
    o["fields"] && typeof o["fields"] === "object",
    `${source}: "fields" must be an object`,
  );

  const fields: Record<string, FieldSpec> = {};
  for (const [name, value] of Object.entries(o["fields"] as Record<string, unknown>)) {
    assert(value && typeof value === "object", `${source}: field "${name}" must be an object`);
    const f = value as Record<string, unknown>;
    assert(
      typeof f["selector"] === "string" && f["selector"],
      `${source}: field "${name}" needs a "selector"`,
    );
    assert(
      typeof f["type"] === "string" && FIELD_TYPES.has(f["type"]),
      `${source}: field "${name}" needs "type" of string | number | list`,
    );
    fields[name] = {
      selector: f["selector"] as string,
      type: f["type"] as FieldSpec["type"],
      required: f["required"] === undefined ? true : Boolean(f["required"]),
      ...(typeof f["min"] === "number" ? { min: f["min"] } : {}),
      ...(typeof f["max"] === "number" ? { max: f["max"] } : {}),
      ...(typeof f["minItems"] === "number" ? { minItems: f["minItems"] } : {}),
      ...(typeof f["attr"] === "string" ? { attr: f["attr"] } : {}),
    };
  }
  assert(Object.keys(fields).length > 0, `${source}: needs at least one field`);

  if (o["auth"] !== undefined) {
    assert(o["auth"] && typeof o["auth"] === "object", `${source}: "auth" must be an object`);
    const a = o["auth"] as Record<string, unknown>;
    if (a["headerEnv"] !== undefined) {
      assert(a["headerEnv"] && typeof a["headerEnv"] === "object", `${source}: "auth.headerEnv" must be an object`);
      for (const [header, varName] of Object.entries(a["headerEnv"] as Record<string, unknown>)) {
        assert(
          typeof varName === "string" && varName,
          `${source}: auth.headerEnv["${header}"] must name an environment variable`,
        );
        assert(
          !/\s/.test(varName) && varName === varName.trim(),
          `${source}: auth.headerEnv["${header}"] should be a variable NAME, not a secret value`,
        );
      }
    }
    if (a["cookieEnv"] !== undefined) {
      assert(typeof a["cookieEnv"] === "string" && a["cookieEnv"], `${source}: "auth.cookieEnv" must be a string`);
    }
    if (a["basicEnv"] !== undefined) {
      const b = a["basicEnv"] as Record<string, unknown>;
      assert(
        typeof b?.["user"] === "string" && typeof b?.["pass"] === "string",
        `${source}: "auth.basicEnv" needs "user" and "pass" environment variable names`,
      );
    }
  }

  if (o["paginate"] !== undefined) {
    assert(o["paginate"] && typeof o["paginate"] === "object", `${source}: "paginate" must be an object`);
    const p = o["paginate"] as Record<string, unknown>;
    assert(
      typeof p["maxPages"] === "number" && p["maxPages"] >= 1,
      `${source}: "paginate.maxPages" is required and caps how far it will crawl`,
    );
    assert(
      typeof p["next"] === "string" || typeof p["urlTemplate"] === "string",
      `${source}: "paginate" needs either "next" (a link selector) or "urlTemplate"`,
    );
    if (typeof p["urlTemplate"] === "string") {
      assert(
        p["urlTemplate"].includes("{page}"),
        `${source}: "paginate.urlTemplate" must contain {page}`,
      );
    }
  }

  const spec: ScraperSpec = {
    name: o["name"] as string,
    url: o["url"] as string,
    fields,
  };
  if (o["auth"]) spec.auth = o["auth"] as ScraperSpec["auth"];
  if (o["paginate"]) spec.paginate = o["paginate"] as ScraperSpec["paginate"];
  if (typeof o["row"] === "string") spec.row = o["row"];
  if (o["expect"] && typeof o["expect"] === "object") {
    spec.expect = o["expect"] as ScraperSpec["expect"];
  }
  return spec;
}

export function loadSpec(path: string): ScraperSpec {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new ConfigError(`${path}: ${(e as Error).message}`);
  }
  const spec = validateSpec(raw, path);
  // The filename is the identity used for fixtures, so keep them in step.
  const stem = basename(path, extname(path));
  if (spec.name !== stem) spec.name = stem;
  return spec;
}

export function loadSpecs(dir: string): { path: string; spec: ScraperSpec }[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    throw new ConfigError(`no scraper directory at ${dir}`);
  }
  return entries
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => {
      const path = join(dir, f);
      return { path, spec: loadSpec(path) };
    });
}

/** Rewrite one selector in place, preserving key order and formatting. */
export function patchSpecFile(path: string, target: string, selector: string): void {
  const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  if (target === "__row__") {
    raw["row"] = selector;
  } else {
    const fields = raw["fields"] as Record<string, Record<string, unknown>>;
    if (!fields?.[target]) throw new ConfigError(`${path}: no field "${target}" to patch`);
    fields[target]!["selector"] = selector;
  }
  writeFileSync(path, JSON.stringify(raw, null, 2) + "\n");
}
