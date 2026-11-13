import { existsSync } from "node:fs";
import { join } from "node:path";

import { isObject, isString, type JsonValue } from "../garden/json.ts";
import { publishedPackages } from "./demo.ts";
import { relativeSlashed } from "../verify/slash.ts";

const ENTRY_FIELDS = ["main", "module", "types", "typings", "bin", "exports"];

function targets(value: JsonValue | undefined): string[] {
  if (value === undefined) return [];
  if (isString(value)) return value.includes("*") ? [] : [value];
  if (Array.isArray(value)) return value.flatMap(targets);
  return isObject(value) ? Object.values(value).flatMap(targets) : [];
}

/**
 * The entry files the published packages of `root` declare in `package.json` and lack on disk, one
 * `<package>: <path from root> is missing` line each. Wildcard export patterns are not checked.
 */
export function missingBuildOutput(root: string): string[] {
  return publishedPackages(root).flatMap(({ name, folder, manifest }) => {
    const declared = ENTRY_FIELDS.flatMap((field) =>
      Object.hasOwn(manifest, field) ? targets(manifest[field]) : [],
    );
    return [...new Set(declared.map((target) => join(folder, target)))]
      .filter((path) => !existsSync(path))
      .map((path) => `${name}: ${relativeSlashed(root, path)} is missing`);
  });
}

/** Throws, naming each missing entry file, when the module the demo would run is not built. */
export function assertBuilt(root: string): void {
  const missing = missingBuildOutput(root);
  if (missing.length === 0) return;
  throw new Error(
    [
      "the module is not built, so the demo would load it without its build output:",
      ...missing.map((line) => `  ${line}`),
      "Run pnpm run build first.",
    ].join("\n"),
  );
}
