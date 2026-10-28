import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";

type Json = string | number | boolean | null | Json[] | JsonObject;

interface JsonObject {
  [key: string]: Json;
}

interface Manifest {
  name: string;
  exports: Json | undefined;
}

function isObject(value: Json | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isText(value: Json | undefined): value is string {
  return typeof value === "string";
}

function readManifest(directory: string): Manifest | undefined {
  let parsed: Json;
  try {
    parsed = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
  } catch {
    return undefined;
  }
  if (!isObject(parsed) || !isText(parsed.name)) return undefined;
  return { name: parsed.name, exports: parsed.exports };
}

/** The nearest enclosing package that has a name, with the directory holding its manifest. */
export function enclosingPackage(
  file: string,
): { directory: string; manifest: Manifest } | undefined {
  let directory = dirname(file);
  for (;;) {
    const manifest = readManifest(directory);
    if (manifest !== undefined) return { directory, manifest };
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

/** The subpath of `specifier` inside package `name` (`.` for the root), or undefined when it names another package. */
export function selfSubpath(
  name: string,
  specifier: string,
): string | undefined {
  if (specifier === name) return ".";
  return specifier.startsWith(`${name}/`)
    ? `./${specifier.slice(name.length + 1)}`
    : undefined;
}

function exportKeys(exportsField: Json): string[] {
  if (!isObject(exportsField)) return ["."];
  const keys = Object.keys(exportsField);
  return keys.some((key) => key.startsWith(".")) ? keys : ["."];
}

function patternMatches(key: string, subpath: string): boolean {
  const star = key.indexOf("*");
  if (star === -1) return key === subpath;
  const prefix = key.slice(0, star);
  const suffix = key.slice(star + 1);
  return (
    subpath.length >= key.length - 1 &&
    subpath.startsWith(prefix) &&
    subpath.endsWith(suffix)
  );
}

/** Whether the package `exports` map publishes `subpath`, so Node can resolve a self-import to it. */
export function exportsCover(
  exportsField: Json | undefined,
  subpath: string,
): boolean {
  if (exportsField === undefined || exportsField === null) return false;
  return exportKeys(exportsField).some((key) => patternMatches(key, subpath));
}

/** Whether `node_modules/<name>` is a link back to the package itself, as a workspace self-link makes it. */
export function isSelfLinked(directory: string, name: string): boolean {
  const installed = join(directory, "node_modules", ...name.split("/"));
  try {
    return (
      lstatSync(installed).isSymbolicLink() &&
      realpathSync(installed) === realpathSync(directory)
    );
  } catch {
    return false;
  }
}
