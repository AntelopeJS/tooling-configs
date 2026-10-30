import { existsSync, globSync, readFileSync } from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";

/** Source extensions tried, in order, for a build output's stem. */
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts"];

/** Build outputs and declarations whose extension is replaced by a source one. */
const OUTPUT_EXTENSION = /(?:\.d)?\.[cm]?[jt]sx?$/;

/** A TypeScript source file, as opposed to a declaration file. */
const TYPESCRIPT_SOURCE = /(?<!\.d)\.[cm]?tsx?$/;

function readJson(path) {
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : undefined;
}

/** Reads the `packages` list of pnpm-workspace.yaml without a YAML dependency. */
function pnpmPackages(root) {
  const path = join(root, "pnpm-workspace.yaml");
  if (!existsSync(path)) return [];
  const patterns = [];
  let inPackages = false;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    if (/^\S/.test(line)) inPackages = /^packages\s*:/.test(line);
    const item = inPackages && line.match(/^\s+-\s*(.+?)\s*(?:#.*)?$/);
    if (item) patterns.push(item[1].replace(/^(["'])(.*)\1$/, "$2"));
  }
  return patterns;
}

function workspacePatterns(root, manifest) {
  const workspaces = manifest?.workspaces;
  const declared = Array.isArray(workspaces)
    ? workspaces
    : (workspaces?.packages ?? []);
  return [...declared, ...pnpmPackages(root)];
}

function expand(root, patterns) {
  const found = new Set();
  for (const pattern of patterns) {
    const manifests = globSync(
      join(pattern.replace(/^\.\/|\/$/g, "") || ".", "package.json"),
      { cwd: root, exclude: (path) => basename(path) === "node_modules" },
    );
    for (const manifest of manifests)
      found.add(resolve(root, dirname(manifest)));
  }
  return found;
}

/** The checkout root and every workspace package directory it declares. */
function workspacePackages(root) {
  const patterns = workspacePatterns(
    root,
    readJson(join(root, "package.json")),
  );
  const included = expand(
    root,
    patterns.filter((pattern) => !pattern.startsWith("!")),
  );
  const excluded = expand(
    root,
    patterns
      .filter((pattern) => pattern.startsWith("!"))
      .map((pattern) => pattern.slice(1)),
  );
  return [root, ...[...included].filter((dir) => !excluded.has(dir))].filter(
    (dir, index, dirs) => dirs.indexOf(dir) === index,
  );
}

/** Output and source directories: the package tsconfig's, then the dist/src convention. */
function layouts(ts, dir) {
  const conventional = { outDir: join(dir, "dist"), rootDir: join(dir, "src") };
  const project = join(dir, "tsconfig.json");
  if (!existsSync(project)) return [conventional];
  const { options } = ts.parseJsonConfigFileContent(
    ts.readConfigFile(project, ts.sys.readFile).config ?? {},
    ts.sys,
    dir,
    undefined,
    project,
  );
  const outDir = options.outDir ?? options.declarationDir;
  if (!outDir) return [conventional];
  return [
    { outDir, rootDir: options.rootDir ?? conventional.rootDir },
    conventional,
  ];
}

/**
 * Export targets of one subpath, the `source` condition first and `types` next.
 * An entry is a target path, a fallback array, a conditions object, or `null`.
 */
function targets(entry) {
  if (Array.isArray(entry)) return entry.flatMap(targets);
  if (!(entry instanceof Object)) return entry ? [String(entry)] : [];
  const keys = Object.keys(entry);
  const order = [
    "source",
    "types",
    ...keys.filter((key) => key !== "source" && key !== "types"),
  ];
  return order
    .filter((key) => key in entry)
    .flatMap((key) => targets(entry[key]));
}

function subpaths(manifest) {
  const { exports } = manifest;
  if (exports === undefined) {
    const main = manifest.types ?? manifest.typings ?? manifest.main;
    return main ? [[".", [main]]] : [];
  }
  const map =
    exports instanceof Object &&
    !Array.isArray(exports) &&
    Object.keys(exports).some((key) => key.startsWith("."))
      ? exports
      : { ".": exports };
  return Object.entries(map).map(([subpath, entry]) => [
    subpath,
    targets(entry),
  ]);
}

/** Maps one export target to the source files TypeScript should load instead. */
function sourcesFor(target, dir, candidates) {
  const path = resolve(dir, target);
  const wildcard = target.includes("*");
  if (TYPESCRIPT_SOURCE.test(path)) {
    return wildcard || existsSync(path) ? [path] : [];
  }
  for (const { outDir, rootDir } of candidates) {
    const inside = relative(outDir, path);
    if (inside.startsWith("..") || isAbsolute(inside)) continue;
    const stem = join(rootDir, inside).replace(OUTPUT_EXTENSION, "");
    const files = [
      ...SOURCE_EXTENSIONS.map((extension) => `${stem}${extension}`),
      join(stem, "index.ts"),
    ];
    if (wildcard) return files;
    const found = files.find((file) => existsSync(file));
    if (found) return [found];
  }
  return [];
}

/**
 * `paths` entries that resolve each workspace package's own name and export
 * subpaths to its TypeScript source, so examples never check a stale or
 * missing build of the repository they document.
 */
export function sourcePaths(ts, root) {
  const paths = {};
  for (const dir of workspacePackages(root)) {
    const manifest = readJson(join(dir, "package.json"));
    if (!manifest?.name) continue;
    const candidates = layouts(ts, dir);
    for (const [subpath, entries] of subpaths(manifest)) {
      const sources = entries
        .map((entry) => sourcesFor(entry, dir, candidates))
        .find((files) => files.length);
      if (sources) paths[`${manifest.name}${subpath.slice(1)}`] = sources;
    }
  }
  return paths;
}
