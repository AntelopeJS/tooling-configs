import { posix } from "node:path";
import ts from "../typescript6.ts";

import {
  isFile,
  jsonRoot,
  propertyNamed,
  readText,
  stringValues,
  type CoverageFiles,
} from "./coverage-files.ts";
import { ROOT_PROGRAM } from "./tsc-invocation.ts";

interface TsconfigFacts {
  /** `undefined` when the file sets no `compilerOptions.skipLibCheck`. */
  skipLibCheck: boolean | undefined;
  /** The `extends` entries that name a local file, as repository-relative paths. */
  parents: string[];
  /** The tsconfig files of the project `references`. */
  references: string[];
  /** Whether the file itself sets `include`, `files` or `references`. */
  definesProgram: boolean;
}

const PROGRAM_KEYS = ["include", "files", "references"] as const;

/** A resolved `compilerOptions.skipLibCheck`. */
export interface SkipLibCheckSetting {
  value: boolean;
  /** The files from the program down to the one that sets the value. */
  chain: string[];
}

const facts = new WeakMap<
  CoverageFiles,
  Map<string, TsconfigFacts | undefined>
>();

function insideRepository(path: string): boolean {
  return path !== ".." && !path.startsWith("../");
}

/** The local file an `extends` entry names: the path as written, else with `.json` added, as tsc looks for it. Backslashes read as slashes. */
function extendedFile(
  files: CoverageFiles,
  from: string,
  entry: string,
): string | undefined {
  const written = entry.replaceAll("\\", "/");
  if (!written.startsWith("./") && !written.startsWith("../")) return undefined;
  const target = posix.join(posix.dirname(from), written);
  return [target, `${target}.json`].find(
    (candidate) => insideRepository(candidate) && isFile(files, candidate),
  );
}

/** The tsconfig a project reference names: the file, or `tsconfig.json` of the directory. */
function referencedFile(
  files: CoverageFiles,
  from: string,
  path: string,
): string | undefined {
  const target = posix.join(posix.dirname(from), path.replaceAll("\\", "/"));
  const file = isFile(files, target)
    ? target
    : posix.join(target, ROOT_PROGRAM);
  return insideRepository(file) ? file : undefined;
}

function referencePaths(object: ts.Expression | undefined): string[] {
  const references = propertyNamed(object, "references");
  if (references === undefined || !ts.isArrayLiteralExpression(references))
    return [];
  return references.elements.flatMap((element) =>
    stringValues(propertyNamed(element, "path")),
  );
}

function readFacts(
  files: CoverageFiles,
  file: string,
): TsconfigFacts | undefined {
  const text = readText(files, file);
  if (text === undefined) return undefined;
  const object = jsonRoot(file, text);
  const flag = propertyNamed(
    propertyNamed(object, "compilerOptions"),
    "skipLibCheck",
  );
  const resolve = (found: string | undefined) => (found ? [found] : []);
  return {
    skipLibCheck:
      flag === undefined ? undefined : flag.kind === ts.SyntaxKind.TrueKeyword,
    parents: stringValues(propertyNamed(object, "extends")).flatMap((entry) =>
      resolve(extendedFile(files, file, entry)),
    ),
    references: referencePaths(object).flatMap((path) =>
      resolve(referencedFile(files, file, path)),
    ),
    definesProgram: PROGRAM_KEYS.some(
      (key) => propertyNamed(object, key) !== undefined,
    ),
  };
}

function factsOf(
  files: CoverageFiles,
  file: string,
): TsconfigFacts | undefined {
  let cache = facts.get(files);
  if (cache === undefined) facts.set(files, (cache = new Map()));
  if (!cache.has(file)) cache.set(file, readFacts(files, file));
  return cache.get(file);
}

/** The value `compilerOptions.skipLibCheck` ends up with for `file` and the files down to the one that sets it. A file's own setting overrides what it extends, a later `extends` entry overrides an earlier one, and a package preset is not read: it counts only when it is this package's, and this package ships none. */
export function skipLibCheckSetting(
  files: CoverageFiles,
  file: string,
  ancestors: readonly string[] = [],
): SkipLibCheckSetting | undefined {
  if (ancestors.includes(file)) return undefined;
  const found = factsOf(files, file);
  if (found === undefined) return undefined;
  if (found.skipLibCheck !== undefined)
    return { value: found.skipLibCheck, chain: [file] };
  for (const parent of found.parents.toReversed()) {
    const inherited = skipLibCheckSetting(files, parent, [...ancestors, file]);
    if (inherited !== undefined)
      return { value: inherited.value, chain: [file, ...inherited.chain] };
  }
  return undefined;
}

function closure(
  programs: readonly string[],
  next: (file: string) => readonly string[],
): string[] {
  const seen = new Set<string>();
  const queue = [...programs];
  for (const file of queue) {
    if (seen.has(file)) continue;
    seen.add(file);
    queue.push(...next(file));
  }
  return [...seen];
}

/** `programs` and, for `tsc -b`, the projects they reference, to any depth. */
export function withReferences(
  files: CoverageFiles,
  programs: readonly string[],
): string[] {
  return closure(programs, (file) => factsOf(files, file)?.references ?? []);
}

/** `programs` and the local files they extend, to any depth: every tsconfig a tsc run over them reads. */
export function withExtends(
  files: CoverageFiles,
  programs: readonly string[],
): string[] {
  return closure(programs, (file) => factsOf(files, file)?.parents ?? []);
}

/** Whether `file` sets `include`, `files` or `references` itself, so it is a project tsc can check and not only a base to extend. */
export function definesProgram(files: CoverageFiles, file: string): boolean {
  return factsOf(files, file)?.definesProgram ?? false;
}

/** The file that sets a `true` setting, when git tracks it. Nothing when git ignores it (a generated file such as Nuxt's `.nuxt/tsconfig.json` or the `.dms-types` tree of `ajs dms prepare-types`): the repository cannot edit it, and a tsconfig that only extends it is not refused. */
export function reportedFile(
  files: CoverageFiles,
  setting: SkipLibCheckSetting,
): string | undefined {
  const setter = setting.chain.at(-1);
  return setter !== undefined && files.isTracked(setter) ? setter : undefined;
}
