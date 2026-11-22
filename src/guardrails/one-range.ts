import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  type JsonValue,
  isObject,
  isString,
  parseJson,
} from "../garden/json.ts";
import { tracked } from "./dependency-ranges-sync.ts";

/** The file at the repository root that lists the `@antelopejs/*` packages `dependency:one-range` lets manifests declare with different ranges. */
const ONE_RANGE_FILE = "guardrails.one-range.json";

const ANTELOPEJS_SCOPE = "@antelopejs/";

/** The fields whose entries install a release; a peer range leaves the release to the dependent's install. */
const INSTALLED_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
] as const;

/** Specs that resolve to a folder of the repository rather than a release. */
const LOCAL_SPEC = /^(?:workspace|file|link):/;

const EXPECTED = `expected { "exceptions": ["@antelopejs/<name>"] }`;

/** The package names `ONE_RANGE_FILE` lists at `root`, none when the file is missing, or what is wrong with it. */
function readExceptions(
  root: string,
): { failure: string } | { names: Set<string> } {
  const path = join(root, ONE_RANGE_FILE);
  if (!existsSync(path)) return { names: new Set() };
  let parsed: JsonValue;
  try {
    parsed = parseJson(readFileSync(path, "utf8"));
  } catch (error) {
    return { failure: `${ONE_RANGE_FILE}: ${String(error)}\n` };
  }
  const list =
    isObject(parsed) &&
    Object.keys(parsed).length === 1 &&
    Object.hasOwn(parsed, "exceptions")
      ? parsed.exceptions
      : undefined;
  if (
    !Array.isArray(list) ||
    !list.every((name) => isString(name) && name.startsWith(ANTELOPEJS_SCOPE))
  )
    return { failure: `${ONE_RANGE_FILE}: ${EXPECTED}.\n` };
  return { names: new Set(list.filter(isString)) };
}

/**
 * One line per `@antelopejs/*` package that two tracked manifests declare with different ranges in `dependencies`,
 * `devDependencies` or `optionalDependencies`, naming each range and the manifests that declare it: the lockfile then
 * holds one copy per range. `workspace:`, `file:` and `link:` specs are skipped, and so is each package
 * `guardrails.one-range.json` lists under `exceptions`. Empty when every package has one range.
 */
export function checkOneRange(root: string): string {
  const exceptions = readExceptions(root);
  if ("failure" in exceptions) return exceptions.failure;
  const ranges = new Map<string, Map<string, Set<string>>>();
  for (const { path, manifest } of tracked(root))
    for (const field of INSTALLED_FIELDS)
      for (const [name, spec] of Object.entries(manifest[field] ?? {})) {
        if (
          !name.startsWith(ANTELOPEJS_SCOPE) ||
          LOCAL_SPEC.test(spec) ||
          exceptions.names.has(name)
        )
          continue;
        const byRange = ranges.get(name) ?? new Map<string, Set<string>>();
        ranges.set(name, byRange);
        const paths = byRange.get(spec) ?? new Set<string>();
        byRange.set(spec, paths.add(path));
      }
  return [...ranges]
    .filter(([, byRange]) => byRange.size > 1)
    .map(
      ([name, byRange]) =>
        `"${name}" is declared with ${byRange.size} ranges, and the lockfile holds one copy per range; declare one range in every package.json, or list it under exceptions in ${ONE_RANGE_FILE}:\n${[
          ...byRange,
        ]
          .map(([spec, paths]) => `  "${spec}" in ${[...paths].join(", ")}\n`)
          .join("")}`,
    )
    .join("");
}
