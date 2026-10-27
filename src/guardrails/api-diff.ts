import { generateDtsBundle } from "dts-bundle-generator";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import type ts from "typescript";

import {
  allowedByGlob,
  createAddedPolicy,
  describeAllowance,
  fillStars,
  recordVerdict,
  type AddedPolicy,
  type PublishedEntry,
} from "./added-entries.ts";
import {
  compareRevisions,
  DIRECTORY_LINK,
  revisionCounts,
} from "./revisions.ts";
import { runtimeDiff } from "./runtime-diff.ts";
import {
  emitPackage,
  isTestSource,
  packagesAt,
  type ExportTarget,
  type ProofManifest,
} from "./typescript.ts";

interface PublishedTarget {
  entry: string;
  target: string;
  subpath: string;
}

interface BundledPackage {
  count: number;
  published: PublishedEntry[];
}

interface PackagePaths {
  root: string;
  name: string;
  directory: string;
  output: string;
  scratch: string;
}

function entrySegment(value: string): string {
  return encodeURIComponent(value)
    .replaceAll(".", "%2E")
    .replaceAll("*", "%2A");
}

function entryPattern(value: string): string {
  return value.split("*").map(entrySegment).join("*");
}

function exportTargets(
  target: ExportTarget | undefined,
  entry = "exports/root",
  subpath = ".",
): PublishedTarget[] {
  // eslint-disable-next-line anti-slop/no-runtime-typeof -- package exports is a standard recursive JSON union.
  if (typeof target === "string") return [{ entry, target, subpath }];
  if (target == null) return [];
  if (Array.isArray(target))
    return target.flatMap((value, index) =>
      exportTargets(value, `${entry}/fallback/${index}`, subpath),
    );
  if (target.types !== undefined)
    return exportTargets(target.types, entry, subpath);
  return Object.entries(target).flatMap(([key, value]) => {
    const name = key.startsWith(".")
      ? key === "."
        ? "exports/root"
        : `exports/subpath/${entryPattern(key.slice(2))}`
      : `${entry}/condition/${entrySegment(key)}`;
    const published = key.startsWith(".") ? key.slice(2) || "." : subpath;
    return exportTargets(value, name, published);
  });
}

function declarationTarget(target: string): string {
  return target.replace(
    /(?<!\.d)\.(mjs|cjs|js|mts|cts|tsx?|jsx)$/u,
    (extension) => {
      if (extension === ".mjs" || extension === ".mts") return ".d.mts";
      if (extension === ".cjs" || extension === ".cts") return ".d.cts";
      return ".d.ts";
    },
  );
}

function entryPatterns(manifest: ProofManifest): PublishedTarget[] {
  const targets = exportTargets(manifest.exports);
  for (const key of ["main", "types", "typings"] as const) {
    const target = manifest[key];
    if (target !== undefined)
      targets.push({ entry: key, target, subpath: key });
  }
  for (const [version, mappings] of Object.entries(
    manifest.typesVersions ?? {},
  ))
    for (const [entry, paths] of Object.entries(mappings))
      for (const [index, target] of paths.entries())
        targets.push({
          entry: `typesVersions/${entrySegment(version)}/${entryPattern(entry)}/${index}`,
          target,
          subpath: entry,
        });
  return targets
    .map((published) => ({
      ...published,
      target: declarationTarget(published.target),
    }))
    .filter(
      ({ target }) => /\.d\.[cm]?ts$/u.test(target) || target.includes("*"),
    );
}

/** Export stars are substitutions rather than path globs and can span directory separators. */
function targetPattern(target: string): RegExp {
  return new RegExp(
    `^${target
      .split("*")
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"))
      .join("(.*)")}$`,
    "u",
  );
}

function publishedEntries(
  directory: string,
  manifest: ProofManifest,
  emitted: ReturnType<typeof emitPackage>,
  scratch: string,
) {
  const outputRoot = resolve(directory, emitted.options.outDir ?? ".");
  const files = emitted.files.map((file) =>
    relative(scratch, file).split("\\").join("/"),
  );
  const entries: { entry: string; file: string; subpath: string }[] = [];
  for (const { entry, target, subpath } of entryPatterns(manifest)) {
    if (isTestSource(outputRoot, resolve(directory, target))) continue;
    const path = relative(outputRoot, resolve(directory, target))
      .split("\\")
      .join("/");
    const pattern = targetPattern(path);
    const matches = files.filter((file) => pattern.test(file));
    if (!matches.length && !path.includes("*"))
      throw new Error(
        `${directory}: published target ${target} has no emitted declaration.`,
      );
    for (const file of matches) {
      const captures = pattern.exec(file)?.slice(1) ?? [];
      const name = entry.includes("*")
        ? fillStars(entry, captures, entrySegment)
        : `${entry}${captures.length ? `/file/${entrySegment(file)}` : ""}`;
      entries.push({
        entry: `${name}.d.ts`,
        file,
        subpath: subpath.includes("*")
          ? fillStars(subpath, captures)
          : captures.length
            ? `${subpath}/${captures[0]}`
            : subpath,
      });
    }
  }
  return entries.sort((a, b) => a.entry.localeCompare(b.entry));
}

function statementName(
  compiler: typeof ts,
  statement: ts.Statement,
  source: ts.SourceFile,
): string {
  if (compiler.isVariableStatement(statement))
    return (
      statement.declarationList.declarations[0]?.name.getText(source) ?? ""
    );
  if (
    compiler.isFunctionDeclaration(statement) ||
    compiler.isClassDeclaration(statement) ||
    compiler.isInterfaceDeclaration(statement) ||
    compiler.isTypeAliasDeclaration(statement) ||
    compiler.isEnumDeclaration(statement) ||
    compiler.isModuleDeclaration(statement) ||
    compiler.isImportEqualsDeclaration(statement)
  )
    return statement.name?.getText(source) ?? "default";
  return statement.getText(source);
}

function normalizeBundle(compiler: typeof ts, text: string): string {
  const source = compiler.createSourceFile(
    "bundle.d.ts",
    text,
    compiler.ScriptTarget.Latest,
    true,
  );
  const statements = [...source.statements].sort((a, b) =>
    statementName(compiler, a, source).localeCompare(
      statementName(compiler, b, source),
    ),
  );
  const normalized = compiler.factory.updateSourceFile(source, statements);
  return compiler
    .createPrinter({
      removeComments: true,
      newLine: compiler.NewLineKind.LineFeed,
    })
    .printFile(normalized);
}

function bundleDependencies(directory: string, scratch: string): void {
  let current = directory;
  while (!existsSync(join(current, "node_modules"))) {
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
  symlinkSync(
    join(current, "node_modules"),
    join(scratch, "node_modules"),
    DIRECTORY_LINK,
  );
}

/** dts-bundle-generator 9 remaps a .d.mts/.d.cts root twice; a source-named copy preserves its declaration text. */
function generatorEntry(file: string): string {
  const alias = file.replace(/\.d\.([cm]ts)$/u, ".$1");
  if (alias !== file) copyFileSync(file, alias);
  return alias;
}

function bundlePackage(
  paths: PackagePaths,
  manifest: ProofManifest,
  policy?: AddedPolicy,
): BundledPackage {
  const { directory, output, scratch } = paths;
  const emitted = emitPackage(directory, scratch, true);
  const entries = publishedEntries(directory, manifest, emitted, scratch);
  if (!entries.length) return { count: 0, published: [] };
  bundleDependencies(directory, scratch);
  writeFileSync(
    join(scratch, "package.json"),
    readFileSync(join(directory, "package.json")),
  );
  const config = join(scratch, "tsconfig.json");
  writeFileSync(
    config,
    JSON.stringify({
      extends: join(directory, "tsconfig.json"),
      compilerOptions: {
        composite: false,
        incremental: false,
        noEmit: false,
        rootDir: scratch,
      },
      files: entries.map(({ file }) => join(scratch, file)),
      include: [],
    }),
  );
  const bundles = generateDtsBundle(
    entries.map(({ file }) => ({
      filePath: generatorEntry(join(scratch, file)),
      output: { exportReferencedTypes: false, noBanner: true },
      libraries: { inlinedLibraries: [] },
    })),
    { preferredConfigPath: config },
  );
  for (const [index, { entry }] of entries.entries()) {
    const path = join(output, entry);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, normalizeBundle(emitted.compiler, bundles[index]));
  }
  if (policy !== undefined)
    for (const { file, subpath } of entries) {
      if (!allowedByGlob(policy, subpath)) continue;
      const emittedFile = join(scratch, file);
      const module = emitted.modules.get(resolve(emittedFile)) ?? emittedFile;
      recordVerdict(policy, emitted.compiler, {
        directory: paths.name,
        subpath,
        module,
        label: relative(paths.root, module).split("\\").join("/"),
      });
    }
  return {
    count: entries.length,
    published: entries.map(({ entry, subpath }) => ({
      path: `${paths.name === "." ? "_root" : paths.name}/${entry}`,
      directory: paths.name,
      subpath,
    })),
  };
}

function declarationDiff(
  root: string,
  baseRef: string,
  policy: AddedPolicy | undefined,
) {
  return compareRevisions(
    root,
    baseRef,
    "API",
    (worktree, output, scratch) => {
      const packages = packagesAt(worktree, true);
      const published: PublishedEntry[] = [];
      let entries = 0;
      for (const { directory, manifest } of packages) {
        const bundled = bundlePackage(
          {
            root: worktree,
            name: directory,
            directory: join(worktree, directory),
            output: join(output, directory === "." ? "_root" : directory),
            scratch: join(scratch, directory === "." ? "_root" : directory),
          },
          manifest,
          policy,
        );
        entries += bundled.count;
        published.push(...bundled.published);
      }
      return {
        packages: packages.map(({ directory }) => directory),
        entries,
        published,
      };
    },
    policy,
  );
}

/** Compares declarations and built runtime exports, with an optional behavioral probe captured before either build. Added entries whose subpath matches an `allowAdded` glob pass when their module is `@internal`. */
export function apiDiff(
  root: string,
  baseRef: string,
  probeFile?: string,
  allowAdded: readonly string[] = [],
) {
  const policy = allowAdded.length ? createAddedPolicy(allowAdded) : undefined;
  const probe =
    probeFile === undefined
      ? undefined
      : readFileSync(resolve(root, probeFile));
  const results: { different: boolean; output: string }[] = [];
  const errors: string[] = [];
  for (const compare of [
    () => declarationDiff(root, baseRef, policy),
    () => runtimeDiff(root, baseRef, probe, policy),
  ]) {
    try {
      results.push(compare());
    } catch (error) {
      errors.push(
        `Execution error: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  }
  return {
    different:
      errors.length > 0 ||
      results.some((result) => result.different) ||
      (policy?.problems.size ?? 0) > 0,
    output:
      results.map((result) => result.output).join("") +
      (policy === undefined ? "" : describeAllowance(policy)) +
      errors.join("") +
      (probe === undefined
        ? "No behavioural probe ran.\n"
        : "Behavioural probe supplied.\n") +
      revisionCounts(root, baseRef),
  };
}
