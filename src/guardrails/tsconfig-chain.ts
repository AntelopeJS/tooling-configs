import { posix } from "node:path";
import ts from "@typescript/typescript6";

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
}

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

/** `programs` and, for `tsc -b`, the projects they reference, to any depth. */
export function withReferences(
  files: CoverageFiles,
  programs: readonly string[],
): string[] {
  const seen = new Set<string>();
  const queue = [...programs];
  for (const file of queue) {
    if (seen.has(file)) continue;
    seen.add(file);
    queue.push(...(factsOf(files, file)?.references ?? []));
  }
  return [...seen];
}

/** The file to report a `true` setting against: the file that sets it, or when git ignores that one (a generated file such as Nuxt's `.nuxt/tsconfig.json`) the first file of the chain git does not ignore, which overrides it. Nothing when every file of the chain is generated. */
export function reportedFile(
  files: CoverageFiles,
  setting: SkipLibCheckSetting,
): { file: string; sets: boolean } | undefined {
  const setter = setting.chain.at(-1);
  if (setter !== undefined && files.isTracked(setter))
    return { file: setter, sets: true };
  const file = setting.chain.find((candidate) => files.isTracked(candidate));
  return file === undefined ? undefined : { file, sets: false };
}
