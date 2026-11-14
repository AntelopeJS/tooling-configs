import { join } from "node:path";
import ts from "@typescript/typescript6";

import type { ExportTarget } from "./package.ts";

/** The compiler options of the consumer: the strictest a consumer commonly sets, with every declaration file it loads checked. */
export const CONSUMER_OPTIONS = {
  module: "nodenext",
  moduleResolution: "nodenext",
  target: "esnext",
  strict: true,
  skipLibCheck: false,
  noEmit: true,
  types: ["node"],
};

/** The consumer files, an ES module that imports each entry and a CommonJS module that requires it, with the resolution mode TypeScript gives each. */
export const CONSUMER_FILES: Record<
  "import" | "require",
  { file: string; mode: ts.ResolutionMode }
> = {
  import: { file: "consumer.mts", mode: ts.ModuleKind.ESNext },
  require: { file: "consumer.cts", mode: ts.ModuleKind.CommonJS },
};

type Mode = keyof typeof CONSUMER_FILES;

const DECLARATION_EXTENSIONS = new Set<string>([
  ts.Extension.Dts,
  ts.Extension.Dmts,
  ts.Extension.Dcts,
]);

const DECLARATION_FILE = /\.d\.[cm]?ts$/;

/** An `exports` value that names declarations: a `types` condition or a `.d.ts`, `.d.mts` or `.d.cts` target. */
const NAMES_DECLARATIONS = /"types"\s*:|\.d\.[cm]?ts"/;

function isPath(target: ExportTarget): target is string {
  return typeof target === "string";
}

/** Every path a subpath's value lists, under any condition. */
function targetPaths(target: ExportTarget): string[] {
  if (target === null) return [];
  if (isPath(target)) return [target];
  return (Array.isArray(target) ? target : Object.values(target)).flatMap(
    targetPaths,
  );
}

/** `exports` as a map of subpaths: a path, a list or a map of conditions stands for the `.` subpath. */
function subpaths(exports: ExportTarget): [string, ExportTarget][] {
  if (exports === null || isPath(exports) || Array.isArray(exports))
    return [[".", exports]];
  const entries = Object.entries(exports);
  return entries.every(([key]) => key.startsWith("."))
    ? entries
    : [[".", exports]];
}

function patternMatcher(pattern: string): RegExp {
  const [before = "", after = ""] = pattern.split("*");
  const escape = (text: string) => text.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escape(before)}(.+)${escape(after)}$`);
}

/** The subpaths a key stands for: itself, or, for a `*` key, one per shipped file a target of its value matches. */
function expanded(
  key: string,
  value: ExportTarget,
  files: readonly string[],
): string[] {
  if (!key.includes("*")) return [key];
  return targetPaths(value).flatMap((target) => {
    const matcher = patternMatcher(target.replace(/^\.\//, ""));
    return files.flatMap((file) => {
      const star = matcher.exec(file)?.[1];
      return star === undefined ? [] : [key.replace("*", star)];
    });
  });
}

/** A specifier for each subpath of `exports`, with whether its value names declarations; a subpath naming a declaration file is left out, since no consumer imports one by name. */
function candidates(
  name: string,
  exports: ExportTarget,
  files: readonly string[],
): Map<string, boolean> {
  const found = new Map<string, boolean>();
  for (const [key, value] of subpaths(exports))
    for (const subpath of expanded(key, value, files))
      if (!DECLARATION_FILE.test(subpath))
        found.set(
          `${name}${subpath.slice(1)}`,
          (found.get(`${name}${subpath.slice(1)}`) ?? false) ||
            NAMES_DECLARATIONS.test(JSON.stringify(value)),
        );
  return found;
}

/**
 * The specifiers the consumer in `consumer` imports and requires from the package `name`, given the `files` it ships
 * relative to its folder. Each `exports` subpath, a `*` subpath once per shipped file a target of it matches, is kept
 * for a mode when TypeScript resolves it in that mode to a declaration file, or to JavaScript while its value names
 * declarations, so a declaration file missing from the tarball fails. A subpath TypeScript does not resolve, such as one
 * a `null` key hides or a stylesheet, is left out. A package without `exports` is imported by its bare name.
 */
export function entrySpecifiers(
  name: string,
  exports: ExportTarget | undefined,
  files: readonly string[],
  consumer: string,
): Record<Mode, string[]> {
  if (exports === undefined) return { import: [name], require: [] };
  const { options } = ts.convertCompilerOptionsFromJson(
    CONSUMER_OPTIONS,
    consumer,
  );
  const found = [...candidates(name, exports, files)];
  const kept = (mode: Mode) =>
    found.flatMap(([specifier, namesDeclarations]) => {
      const { resolvedModule } = ts.resolveModuleName(
        specifier,
        join(consumer, CONSUMER_FILES[mode].file),
        options,
        ts.sys,
        undefined,
        undefined,
        CONSUMER_FILES[mode].mode,
      );
      if (!resolvedModule) return [];
      return DECLARATION_EXTENSIONS.has(resolvedModule.extension) ||
        namesDeclarations
        ? [specifier]
        : [];
    });
  return { import: kept("import"), require: kept("require") };
}
