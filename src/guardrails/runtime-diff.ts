import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import {
  fillStars,
  type AddedPolicy,
  type PublishedEntry,
} from "./added-entries.ts";
import {
  packageManager,
  parseManifest,
  type PackageManager,
} from "./package.ts";
import { compareRevisions } from "./revisions.ts";
import { testEntryNotice } from "./test-entries.ts";
import {
  isTestSource,
  outputRoot,
  packagesAt,
  isExportPath,
  type ExportTarget,
  type ProofManifest,
} from "./typescript.ts";

const DESCRIBE = `
const { readFileSync, existsSync } = require("node:fs");
const { dirname, join, extname } = require("node:path");
const { pathToFileURL } = require("node:url");
const file = process.argv[2];
let directory = dirname(file);
while (!existsSync(join(directory, "package.json")) && dirname(directory) !== directory) directory = dirname(directory);
const manifest = existsSync(join(directory, "package.json")) ? JSON.parse(readFileSync(join(directory, "package.json"), "utf8")) : {};
const esm = extname(file) === ".mjs" || (extname(file) === ".js" && manifest.type === "module");
const seen = new Map();
function functionInfo(fn) {
  let constructible = true;
  try { Reflect.construct(Object, [], fn); } catch { constructible = false; }
  return { name: fn.name, length: fn.length, async: Object.getPrototypeOf(fn) === Object.getPrototypeOf(async function() {}), constructible };
}
function valueInfo(value) {
  if (typeof value !== "function") return { kind: value === null ? "null" : typeof value };
  if (seen.has(value)) return { kind: "reference", id: seen.get(value) };
  const id = seen.size;
  seen.set(value, id);
  return { kind: "function", id, function: functionInfo(value), static: properties(value, false), prototype: value.prototype ? properties(value.prototype, false) : [] };
}
function properties(object, observe) {
  if (object === null || !["object", "function"].includes(typeof object)) return [];
  return Reflect.ownKeys(object).map(key => {
    const d = Object.getOwnPropertyDescriptor(object, key);
    const common = { key: typeof key === "symbol" ? { symbol: String(key) } : key, enumerable: d.enumerable, configurable: d.configurable };
    return "value" in d
      ? { ...common, kind: "data", writable: d.writable, value: valueInfo(d.value) }
      : { ...common, kind: "accessor", get: d.get ? functionInfo(d.get) : null, set: d.set ? functionInfo(d.set) : null, observed: observe ? valueInfo(Reflect.get(object, key)) : null };
  });
}
(async () => {
  const value = esm ? await import(pathToFileURL(file).href) : require(file);
  process.stdout.write(JSON.stringify({ kind: esm ? "esm" : "cjs", value: valueInfo(value), properties: typeof value === "function" ? [] : properties(value, true) }));
})().catch(error => { process.stderr.write(String(error.stack)); process.exitCode = 1; });
`;

interface RuntimeTarget {
  entry: string;
  target: string;
  subpath: string;
}

function runtimeTargets(
  target: ExportTarget | undefined,
  entry = "exports",
  subpath = ".",
): RuntimeTarget[] {
  if (target == null) return [];
  if (Array.isArray(target))
    return target.flatMap((value, index) =>
      runtimeTargets(value, `${entry}/${index}`, subpath),
    );
  if (isExportPath(target)) return [{ entry, target, subpath }];
  return Object.entries(target).flatMap(([key, value]) => {
    if (key === "types") return [];
    if (["browser", "deno", "react-native"].includes(key))
      throw new Error(`${entry}/${key}: unsupported runtime environment.`);
    return runtimeTargets(
      value,
      `${entry}/${key}`,
      key.startsWith(".") ? key.slice(2) || "." : subpath,
    );
  });
}

/** The regular files below `directory`, following a directory link unless it leads back to a directory the walk is already inside, so a dependency linked back to its own package cannot loop the walk. */
function filesUnder(
  directory: string,
  ancestors: ReadonlySet<string> = new Set(),
): string[] {
  const real = realpathSync(directory);
  if (ancestors.has(real)) return [];
  const inside = new Set(ancestors).add(real);
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (
      entry.isDirectory() ||
      (entry.isSymbolicLink() &&
        existsSync(path) &&
        statSync(path).isDirectory())
    )
      return filesUnder(path, inside);
    return entry.isFile() ? [path] : [];
  });
}

interface BuiltEntries {
  entries: { entry: string; file: string; subpath: string }[];
  skipped: string[];
}

function builtEntries(
  directory: string,
  manifest: ProofManifest,
): BuiltEntries {
  const targets = runtimeTargets(manifest.exports);
  if (manifest.main)
    targets.push({ entry: "main", target: manifest.main, subpath: "main" });
  if (!targets.length)
    throw new Error(`${directory}: no published runtime entry.`);
  const output = outputRoot(directory);
  const skipped: string[] = [];
  const entries = targets
    .filter(({ target }) => !target.endsWith(".json"))
    .filter(({ target }) => {
      if (!isTestSource(output, resolve(directory, target))) return true;
      skipped.push(target);
      return false;
    })
    .flatMap(({ entry, target, subpath }) => {
      if (!target.includes("*")) {
        const file = resolve(directory, target);
        if (!existsSync(file))
          throw new Error(
            `${directory}: missing built runtime entry ${target}.`,
          );
        return [{ entry, file, subpath }];
      }
      const prefix = resolve(directory, target.slice(0, target.indexOf("*")));
      const parent = dirname(prefix);
      const pattern = new RegExp(
        `^${resolve(directory, target)
          .split("*")
          .map((part) => part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"))
          .join("(.*)")}$`,
        "u",
      );
      if (!existsSync(parent))
        throw new Error(`${directory}: missing build output for ${target}.`);
      const found = filesUnder(parent).filter((file) => pattern.test(file));
      if (!found.length)
        throw new Error(`${directory}: missing built runtime entry ${target}.`);
      const matches = found.filter((file) => !isTestSource(output, file));
      if (matches.length < found.length) skipped.push(target);
      return matches.sort().map((file) => {
        const capture = pattern.exec(file)?.[1] ?? relative(directory, file);
        return {
          entry: entry.replaceAll("*", capture),
          file,
          subpath: fillStars(subpath, [capture]),
        };
      });
    });
  return { entries, skipped };
}

function childJson(args: string[], cwd: string): string {
  const result = spawnSync(process.execPath, args, {
    cwd,
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(
      result.stderr ||
        `Runtime child exited with ${result.status ?? result.signal}.`,
    );
  return `${JSON.stringify(JSON.parse(result.stdout), null, 2)}\n`;
}

/** The package manager that builds `directory`, read like corepack reads it: from the nearest manifest between `directory` and `worktree` that declares `packageManager`, or pnpm when none does. */
function declaredPackageManager(
  worktree: string,
  directory: string,
): PackageManager {
  for (let folder = directory; ; folder = dirname(folder)) {
    const path = join(worktree, folder, "package.json");
    if (existsSync(path)) {
      const manifest = parseManifest(readFileSync(path, "utf8"));
      if (manifest.packageManager !== undefined)
        return packageManager(manifest);
    }
    if (folder === ".") return packageManager({});
  }
}

function buildPackage(
  directory: string,
  manager: PackageManager,
  output: string,
  manifest: ProofManifest,
  describe: string,
):
  | {
      count: number;
      entries: { entry: string; subpath: string }[];
      skipped: string[];
    }
  | undefined {
  const buildManifest = parseManifest(
    readFileSync(join(directory, "package.json"), "utf8"),
  );
  if (buildManifest.scripts?.build)
    execFileSync(manager, ["run", "build"], {
      cwd: directory,
      encoding: "utf8",
      shell: process.platform === "win32",
      env: { ...process.env, pnpm_config_verify_deps_before_run: "false" },
      timeout: 120_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
  let built: BuiltEntries;
  try {
    built = builtEntries(directory, manifest);
  } catch (error) {
    if (buildManifest.scripts?.build) throw error;
    return undefined;
  }
  const { entries, skipped } = built;
  for (const { entry, file } of entries) {
    const destination = join(output, `${encodeURIComponent(entry)}.json`);
    const metadata = childJson([describe, file], directory);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, metadata);
  }
  return { count: entries.length, entries, skipped };
}

/** Builds both committed revisions and compares published runtime metadata and one captured optional probe. */
export function runtimeDiff(
  root: string,
  baseRef: string,
  probe: Buffer | undefined,
  policy?: AddedPolicy,
) {
  const errors: string[] = [];
  const failedPackages = new Set<string>();
  const skippedPackages = new Set<string>();
  const skippedTests = new Set<string>();
  const result = compareRevisions(
    root,
    baseRef,
    "Runtime API",
    (worktree, output, scratch) => {
      const packages = packagesAt(worktree, true);
      const published: PublishedEntry[] = [];
      let entries = 0;
      mkdirSync(scratch, { recursive: true });
      const describe = join(scratch, "describe.cjs");
      writeFileSync(describe, DESCRIBE);
      for (const { directory, manifest } of packages) {
        const folder = encodeURIComponent(directory).replaceAll(".", "%2E");
        try {
          const built = buildPackage(
            join(worktree, directory),
            declaredPackageManager(worktree, directory),
            join(output, folder),
            manifest,
            describe,
          );
          if (built === undefined) skippedPackages.add(directory);
          else {
            entries += built.count;
            for (const target of built.skipped)
              skippedTests.add(
                testEntryNotice("Runtime API", directory, target),
              );
            published.push(
              ...built.entries.map(({ entry, subpath }) => ({
                path: `${folder}/${encodeURIComponent(entry)}.json`,
                directory,
                subpath,
              })),
            );
          }
        } catch (error) {
          failedPackages.add(directory);
          errors.push(
            `Execution error: ${directory}: ${error instanceof Error ? error.message : String(error)}\n`,
          );
        }
      }
      for (const directory of failedPackages)
        for (const side of ["base", "head"])
          rmSync(
            join(
              dirname(output),
              side,
              encodeURIComponent(directory).replaceAll(".", "%2E"),
            ),
            {
              recursive: true,
              force: true,
            },
          );
      if (probe !== undefined) {
        const script = join(scratch, "probe.cjs");
        writeFileSync(script, probe);
        writeFileSync(
          join(output, "probe.json"),
          childJson([script, worktree], worktree),
        );
      }
      return {
        packages: packages.map(({ directory }) => directory),
        entries,
        published,
      };
    },
    policy,
  );
  return {
    different: result.different || errors.length > 0,
    output:
      (errors.length && !result.different
        ? result.output.replace(
            /^Runtime API:[^\n]*\n/u,
            "Runtime API: comparison incomplete due to execution errors.\n",
          )
        : result.output) +
      [...skippedPackages]
        .map(
          (directory) =>
            `Runtime API: skipped ${directory}, which has no build script and no committed runtime entry.\n`,
        )
        .join("") +
      [...skippedTests].sort().join("") +
      errors.join(""),
  };
}
