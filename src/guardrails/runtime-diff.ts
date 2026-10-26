import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import { packageManager, parseManifest } from "./package.ts";
import { compareRevisions } from "./revisions.ts";
import {
  packagesAt,
  type ExportTarget,
  type ProofManifest,
} from "./typescript.ts";

const DESCRIBE = `
const { readFileSync, existsSync } = require("node:fs");
const { dirname, join, extname } = require("node:path");
const { pathToFileURL } = require("node:url");
const file = process.argv[1];
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

function runtimeTargets(
  target: ExportTarget | undefined,
  entry = "exports",
): { entry: string; target: string }[] {
  if (target == null) return [];
  if (Array.isArray(target))
    return target.flatMap((value, index) =>
      runtimeTargets(value, `${entry}/${index}`),
    );
  if (target.constructor === String) return [{ entry, target: String(target) }];
  return Object.entries(target).flatMap(([key, value]) => {
    if (key === "types") return [];
    if (["browser", "deno", "react-native"].includes(key))
      throw new Error(`${entry}/${key}: unsupported runtime environment.`);
    return runtimeTargets(value, `${entry}/${key}`);
  });
}

function builtEntries(directory: string, manifest: ProofManifest) {
  const targets = runtimeTargets(manifest.exports);
  if (manifest.main) targets.push({ entry: "main", target: manifest.main });
  if (!targets.length)
    throw new Error(`${directory}: no published runtime entry.`);
  return targets
    .filter(({ target }) => !target.endsWith(".json"))
    .flatMap(({ entry, target }) => {
      if (!target.includes("*")) {
        const file = resolve(directory, target);
        if (!existsSync(file))
          throw new Error(
            `${directory}: missing built runtime entry ${target}.`,
          );
        return [{ entry, file }];
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
      const matches = readdirSync(parent, {
        recursive: true,
        withFileTypes: true,
      })
        .filter((file) => file.isFile())
        .map((file) => join(file.parentPath, file.name))
        .filter((file) => pattern.test(file));
      if (!matches.length)
        throw new Error(`${directory}: missing built runtime entry ${target}.`);
      return matches.sort().map((file) => {
        const capture = pattern.exec(file)?.[1] ?? relative(directory, file);
        return { entry: entry.replaceAll("*", capture), file };
      });
    });
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

function buildPackage(
  directory: string,
  output: string,
  manifest: ProofManifest,
): number | undefined {
  const buildManifest = parseManifest(
    readFileSync(join(directory, "package.json"), "utf8"),
  );
  if (buildManifest.scripts?.build)
    execFileSync(packageManager(buildManifest), ["run", "build"], {
      cwd: directory,
      encoding: "utf8",
      timeout: 120_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
  let entries: ReturnType<typeof builtEntries>;
  try {
    entries = builtEntries(directory, manifest);
  } catch (error) {
    if (buildManifest.scripts?.build) throw error;
    return undefined;
  }
  for (const { entry, file } of entries) {
    const destination = join(output, `${encodeURIComponent(entry)}.json`);
    const metadata = childJson(["-e", DESCRIBE, file], directory);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, metadata);
  }
  return entries.length;
}

/** Builds both committed revisions and compares published runtime metadata and one captured optional probe. */
export function runtimeDiff(
  root: string,
  baseRef: string,
  probe: Buffer | undefined,
) {
  const errors: string[] = [];
  const failedPackages = new Set<string>();
  const skippedPackages = new Set<string>();
  const result = compareRevisions(
    root,
    baseRef,
    "Runtime API",
    (worktree, output, scratch) => {
      const packages = packagesAt(worktree, true);
      let entries = 0;
      for (const { directory, manifest } of packages) {
        try {
          const built = buildPackage(
            join(worktree, directory),
            join(output, encodeURIComponent(directory).replaceAll(".", "%2E")),
            manifest,
          );
          if (built === undefined) skippedPackages.add(directory);
          else entries += built;
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
        mkdirSync(scratch, { recursive: true });
        const script = join(scratch, "probe.cjs");
        writeFileSync(script, probe);
        writeFileSync(
          join(output, "probe.json"),
          childJson([script, worktree], worktree),
        );
      }
      return { packages: packages.map(({ directory }) => directory), entries };
    },
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
      errors.join(""),
  };
}
