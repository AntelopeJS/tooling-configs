import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import {
  allowedByGlob,
  createAddedPolicy,
  describeAllowance,
  fillStars,
  recordVerdict,
  type AddedPolicy,
  type PublishedEntry,
} from "./added-entries.ts";
import { autoImportDiff } from "./auto-imports.ts";
import { bundleDeclarations } from "./declaration-bundle.ts";
import { normalizeBundle } from "./declaration-order.ts";
import { stampProof } from "./proof-stamp.ts";
import {
  compareRevisions,
  DIRECTORY_LINK,
  revisionCounts,
} from "./revisions.ts";
import { runtimeDiff } from "./runtime-diff.ts";
import { testEntryNotice } from "./test-entries.ts";
import {
  emitPackage,
  isTestSource,
  packagesAt,
  unpublishedAt,
  isExportPath,
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
  skipped: string[];
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
  if (isExportPath(target)) return [{ entry, target, subpath }];
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
  const skipped: string[] = [];
  for (const { entry, target, subpath } of entryPatterns(manifest)) {
    if (isTestSource(outputRoot, resolve(directory, target))) {
      skipped.push(target);
      continue;
    }
    const path = relative(outputRoot, resolve(directory, target))
      .split("\\")
      .join("/");
    const pattern = targetPattern(path);
    const found = files.filter((file) => pattern.test(file));
    if (!found.length && !path.includes("*"))
      throw new Error(
        `${directory}: published target ${target} has no emitted declaration.`,
      );
    const matches = found.filter(
      (file) => !isTestSource(outputRoot, join(outputRoot, file)),
    );
    if (matches.length < found.length) skipped.push(target);
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
  return {
    entries: entries.sort((a, b) => a.entry.localeCompare(b.entry)),
    skipped,
  };
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
  notices?: Set<string>,
): BundledPackage {
  const { directory, output, scratch } = paths;
  const emitted = emitPackage(directory, scratch, true);
  if (emitted.notice !== undefined) notices?.add(emitted.notice);
  const { entries, skipped } = publishedEntries(
    directory,
    manifest,
    emitted,
    scratch,
  );
  if (!entries.length) return { count: 0, published: [], skipped };
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
  const bundles = bundleDeclarations(
    emitted.compilerRoot,
    scratch,
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
    skipped,
  };
}

function declarationDiff(
  root: string,
  baseRef: string,
  policy: AddedPolicy | undefined,
) {
  const errors = new Set<string>();
  const notices = new Set<string>();
  const failedPackages = new Set<string>();
  const unpublished = new Map<string, string>();
  const skippedTests = new Set<string>();
  const result = compareRevisions(
    root,
    baseRef,
    "API",
    (worktree, output, scratch) => {
      const packages = packagesAt(worktree, true);
      for (const { directory, reason } of unpublishedAt(worktree))
        unpublished.set(directory, reason);
      const published: PublishedEntry[] = [];
      let entries = 0;
      for (const { directory, manifest } of packages) {
        const key = directory === "." ? "_root" : directory;
        try {
          const bundled = bundlePackage(
            {
              root: worktree,
              name: directory,
              directory: join(worktree, directory),
              output: join(output, key),
              scratch: join(scratch, key),
            },
            manifest,
            policy,
            notices,
          );
          entries += bundled.count;
          for (const target of bundled.skipped)
            skippedTests.add(testEntryNotice("API", directory, target));
          published.push(...bundled.published);
        } catch (error) {
          failedPackages.add(directory);
          errors.add(
            `Execution error: ${directory}${manifest.name === undefined ? "" : ` (${manifest.name})`}: ${error instanceof Error ? error.message : String(error)}\n`,
          );
        }
      }
      for (const directory of failedPackages)
        for (const side of ["base", "head"])
          rmSync(
            join(
              dirname(output),
              side,
              directory === "." ? "_root" : directory,
            ),
            { recursive: true, force: true },
          );
      return {
        packages: packages.map(({ directory }) => directory),
        entries,
        published,
      };
    },
    policy,
  );
  return {
    different: result.different || errors.size > 0,
    output:
      (errors.size > 0 && !result.different
        ? result.output.replace(
            /^API:[^\n]*\n/u,
            "API: comparison incomplete due to execution errors.\n",
          )
        : result.output) +
      [...unpublished]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([directory, reason]) => `API: skipped ${directory}, ${reason}.\n`)
        .join("") +
      [...skippedTests].sort().join("") +
      [...notices].sort().join("") +
      [...errors].join(""),
  };
}

/** Compares declarations, built runtime exports and the auto-import surface of DMS frontend modules, with an optional behavioral probe captured before either build. Added entries whose subpath matches an `allowAdded` glob pass when their module is `@internal`. */
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
    () => autoImportDiff(root, baseRef),
  ]) {
    try {
      const result = compare();
      if (result !== undefined) results.push(result);
    } catch (error) {
      errors.push(
        `Execution error: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  }
  const command = [
    `antelopejs-api-diff ${baseRef}`,
    ...(probeFile === undefined ? [] : [`--probe ${probeFile}`]),
    ...allowAdded.map((glob) => `--allow-added '${glob}'`),
  ].join(" ");
  return {
    different:
      errors.length > 0 ||
      results.some((result) => result.different) ||
      (policy?.problems.size ?? 0) > 0,
    output: stampProof(
      root,
      command,
      baseRef,
      results.map((result) => result.output).join("") +
        (policy === undefined ? "" : describeAllowance(policy)) +
        errors.join("") +
        (probe === undefined
          ? "No behavioural probe ran.\n"
          : "Behavioural probe supplied.\n") +
        revisionCounts(root, baseRef),
    ),
  };
}
