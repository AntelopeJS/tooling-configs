import { existsSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { minimatch } from "minimatch";
import ts from "@typescript/typescript6";

import { workspaceDirectories } from "./docs-compat.ts";
import { parseManifest } from "./package.ts";
import {
  matchingScripts,
  stepsOf,
  type Step,
  type Target,
} from "./script-steps.ts";

const MAX_DEPTH = 5;
const BUILD = "build";
const UNRESOLVED_SELECTOR = /^!|\.\.\.|\^|\[|\$/u;

interface Walk {
  root: string;
  seen: Set<string>;
  packages?: { directory: string; path: string; name: string | undefined }[];
}

function scriptsIn(directory: string): Map<string, string> {
  const file = join(directory, "package.json");
  if (!existsSync(file)) return new Map();
  const { scripts = {} } = parseManifest(readFileSync(file, "utf8"));
  return new Map(Object.entries(scripts));
}

function workspacePackages(walk: Walk) {
  walk.packages ??= workspaceDirectories(walk.root).map((path) => {
    const directory = join(walk.root, path);
    const { name } = parseManifest(
      readFileSync(join(directory, "package.json"), "utf8"),
    );
    return { directory, path, name };
  });
  return walk.packages;
}

/** The workspace packages a `--filter` or `--workspace` selector matches by name or by path, `undefined` for one this does not model. */
function selected(walk: Walk, from: string, selector: string) {
  if (UNRESOLVED_SELECTOR.test(selector)) return undefined;
  const path = relative(
    walk.root,
    resolve(from, selector.replace(/^\{|\}$/gu, "")),
  );
  const matches = workspacePackages(walk)
    .filter(
      (item) =>
        (item.name !== undefined && minimatch(item.name, selector)) ||
        minimatch(item.path, path),
    )
    .map((item) => item.directory);
  return matches.length ? matches : undefined;
}

function targetDirectories(walk: Walk, from: string, target: Target) {
  if (target.kind === "all")
    return workspacePackages(walk).map((item) => item.directory);
  if (target.kind === "select") return selected(walk, from, target.selector);
  const directory = resolve(from, target.path);
  return target.path.includes("$") ||
    !existsSync(join(directory, "package.json"))
    ? undefined
    : [directory];
}

/** The package directories a script step runs in, `undefined` when a target cannot be resolved. */
function stepDirectories(
  walk: Walk,
  from: string,
  targets: readonly Target[],
): string[] | undefined {
  if (targets.length === 0) return [from];
  const directories = new Set<string>();
  for (const target of targets) {
    const found = targetDirectories(walk, from, target);
    if (found === undefined) return undefined;
    for (const directory of found) directories.add(directory);
  }
  return [...directories];
}

function configFile(directory: string, project: string): string {
  const path = resolve(directory, project);
  return existsSync(path) && statSync(path).isDirectory()
    ? join(path, "tsconfig.json")
    : path;
}

/** Whether a `tsc` command line writes output: `-b`, or a run whose command line or tsconfig chain leaves `noEmit` unset. */
function tscWrites(directory: string, args: readonly string[]): boolean {
  if (/^--?b(?:uild)?$/iu.test(args[0] ?? "")) return true;
  const { options } = ts.parseCommandLine([...args]);
  if (options.noEmit !== undefined) return !options.noEmit;
  const file = configFile(directory, options.project ?? ".");
  if (!existsSync(file)) return true;
  const parsed = ts.getParsedCommandLineOfConfigFile(
    file,
    {},
    { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => undefined },
  );
  return parsed?.options.noEmit !== true;
}

/** Whether one step, run from `directory`, writes: a `tsc` that emits, or a script that reaches one or a `build`. */
function stepWrites(
  walk: Walk,
  directory: string,
  step: Exclude<Step, { kind: "cd" }>,
  depth: number,
): boolean {
  const directories = stepDirectories(walk, directory, step.targets);
  if (directories === undefined) return true;
  if (step.kind === "tsc")
    return directories.some((target) => tscWrites(target, step.args));
  return directories.some((target) =>
    matchingScripts(step.names, scriptsIn(target).keys()).some((script) =>
      scriptWrites(walk, target, script, depth + 1),
    ),
  );
}

/** Whether a script or the `pre` and `post` hooks the package manager runs around it write, its lines run from where each `cd` left them. */
function scriptWrites(
  walk: Walk,
  directory: string,
  name: string,
  depth: number,
): boolean {
  const key = `${directory}\0${name}`;
  const text = scriptsIn(directory).get(name);
  if (text === undefined || walk.seen.has(key)) return false;
  walk.seen.add(key);
  if (name === BUILD || depth > MAX_DEPTH) return true;
  if (
    scriptWrites(walk, directory, `pre${name}`, depth) ||
    scriptWrites(walk, directory, `post${name}`, depth)
  )
    return true;
  let current = directory;
  for (const step of stepsOf(text)) {
    if (step.kind === "cd") {
      if (step.path.includes("$") || step.path.startsWith("~")) return true;
      current = resolve(current, step.path);
    } else if (stepWrites(walk, current, step, depth)) return true;
  }
  return false;
}

/**
 * Whether the `typecheck` script of the package at `root` can write files other steps read: it reaches a `build`
 * script or a `tsc` run that emits, in this package or a workspace package it points the package manager at. A
 * target it cannot resolve, such as a `--dir` read from a variable or a dependency `--filter`, counts as writing, and
 * so does a workspace whose manifests cannot be read.
 */
export function typecheckWrites(root: string): boolean {
  try {
    return scriptWrites({ root, seen: new Set() }, root, "typecheck", 0);
  } catch {
    return true;
  }
}
