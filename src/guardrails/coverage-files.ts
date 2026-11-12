import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "@typescript/typescript6";

import { gitFiles } from "./files.ts";

/** The files one coverage run reads, the repository paths git does not ignore, and the reads that failed. */
export interface CoverageFiles {
  root: string;
  /** Whether git tracks the file or would not ignore it; an ignored file is generated, and no edit to it lasts. */
  isTracked: (file: string) => boolean;
  /** Files that exist but could not be read, with the error code. */
  unreadable: Map<string, string>;
}

export function coverageFiles(root: string): CoverageFiles {
  try {
    const tracked = new Set(gitFiles(root));
    return {
      root,
      isTracked: (file) => tracked.has(file),
      unreadable: new Map(),
    };
  } catch {
    return { root, isTracked: () => true, unreadable: new Map() };
  }
}

/** The text of `file`, or `undefined` when it does not exist or cannot be read; an unreadable file is recorded in `unreadable` and never thrown. */
export function readText(
  files: CoverageFiles,
  file: string,
): string | undefined {
  try {
    return readFileSync(join(files.root, file), "utf8");
  } catch (error) {
    const code =
      error instanceof Error && "code" in error
        ? String(error.code)
        : "unknown error";
    if (code !== "ENOENT" && code !== "ENOTDIR")
      files.unreadable.set(file, code);
    return undefined;
  }
}

export function isFile(files: CoverageFiles, file: string): boolean {
  try {
    return statSync(join(files.root, file)).isFile();
  } catch {
    return false;
  }
}

export function unreadableNotes(files: CoverageFiles): string[] {
  return [...files.unreadable].map(
    ([file, code]) =>
      `could not read ${file} (${code}), so what it sets is not reported.`,
  );
}

/** The property `name` of a JSON object literal; when the key is repeated the last one wins, as when tsc reads it. */
export function propertyNamed(
  object: ts.Expression | undefined,
  name: string,
): ts.Expression | undefined {
  if (object === undefined || !ts.isObjectLiteralExpression(object))
    return undefined;
  return object.properties.findLast(
    (item): item is ts.PropertyAssignment =>
      ts.isPropertyAssignment(item) &&
      (ts.isIdentifier(item.name) || ts.isStringLiteral(item.name)) &&
      item.name.text === name,
  )?.initializer;
}

/** The root value of a JSON text, comments and trailing commas allowed. */
export function jsonRoot(
  file: string,
  text: string,
): ts.Expression | undefined {
  return ts.parseJsonText(file, text).statements[0]?.expression;
}

/** The strings of a JSON string or array of strings. */
export function stringValues(value: ts.Expression | undefined): string[] {
  if (value === undefined) return [];
  const items: readonly ts.Expression[] = ts.isArrayLiteralExpression(value)
    ? value.elements
    : [value];
  return items.filter(ts.isStringLiteral).map((item) => item.text);
}
