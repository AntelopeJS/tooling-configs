import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { isMap, isScalar, isSeq, parseDocument, type Document } from "yaml";

import {
  parseManifest,
  type Manifest,
  type PackageManager,
} from "./package.ts";

export const DOCS_COMPAT_START = "<!-- antelopejs-docs-compat:start -->";
export const DOCS_COMPAT_END = "<!-- antelopejs-docs-compat:end -->";

const LOCKFILE = "pnpm-lock.yaml";
const SCOPE = "@antelopejs/";
const UNRESOLVED = "—";
const LEGACY_MARKER = /^<!--\s*docs-compat:\s*\.\/package\.json#\w+\s*-->\s*$/;
const COMPATIBILITY_HEADING = /^##\s+Compatibility\s*$/i;
const RESOLVED_SECTIONS = [
  "dependencies",
  "optionalDependencies",
  "devDependencies",
] as const;

/** One `@antelopejs/*` dependency of a package: its declared range and the version the lockfile resolves. */
export interface CompatRow {
  name: string;
  supported: string;
  tested: string | undefined;
}

/** The generated block, rows sorted by package name, formatted as oxfmt leaves it. */
export function compatBlock(rows: readonly CompatRow[]): string {
  const sorted = [...rows].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
  const table = [
    ["Package", "Supported", "Tested with"],
    ...sorted.map(({ name, supported, tested }) => [
      `\`${name}\``,
      `\`${supported.replaceAll("|", "\\|")}\``,
      tested === undefined ? UNRESOLVED : `\`${tested}\``,
    ]),
  ];
  const widths = [0, 1, 2].map((column) =>
    Math.max(3, ...table.map((row) => row[column].length)),
  );
  const line = (cells: string[]) =>
    `| ${cells.map((cell, column) => cell.padEnd(widths[column])).join(" | ")} |`;
  return [
    DOCS_COMPAT_START,
    "",
    line(table[0]),
    line(widths.map((width) => "-".repeat(width))),
    ...table.slice(1).map(line),
    "",
    DOCS_COMPAT_END,
    "",
  ].join("\n");
}

function legacySpanEnd(lines: readonly string[], marker: number): number {
  let index = marker + 1;
  while (index < lines.length && !lines[index].trim()) index++;
  while (index < lines.length && lines[index].trimStart().startsWith("|"))
    index++;
  while (index < lines.length && !lines[index].trim()) index++;
  return index;
}

function replaceLegacyTables(
  lines: readonly string[],
  block: string,
): string[] | undefined {
  const placed: string[] = [];
  let replaced = false;
  for (let index = 0; index < lines.length;) {
    if (!LEGACY_MARKER.test(lines[index])) {
      placed.push(lines[index]);
      index++;
      continue;
    }
    if (!replaced) placed.push(...block.split("\n"));
    replaced = true;
    index = legacySpanEnd(lines, index);
  }
  return replaced ? placed : undefined;
}

function finalNewline(text: string): string {
  return text.endsWith("\n") ? text : `${text}\n`;
}

/** The README with the block in place: replacing the markers, a legacy `docs-compat` table, or under `## Compatibility`. */
export function placeCompatBlock(
  current: string | undefined,
  block: string,
): string {
  const text = current ?? "";
  const start = text.indexOf(DOCS_COMPAT_START);
  const end = text.indexOf(DOCS_COMPAT_END);
  if ((start === -1) !== (end === -1) || end < start)
    throw new Error(
      "incomplete antelopejs-docs-compat markers. Repair or delete them, then rerun antelopejs-sync.",
    );
  if (start !== -1)
    return `${text.slice(0, start)}${block}${text.slice(end + DOCS_COMPAT_END.length).replace(/^\r?\n/, "")}`;
  const lines = text.split("\n");
  const legacy = replaceLegacyTables(lines, block);
  if (legacy) return finalNewline(legacy.join("\n"));
  const heading = lines.findIndex((line) => COMPATIBILITY_HEADING.test(line));
  if (heading !== -1) {
    let rest = heading + 1;
    while (rest < lines.length && !lines[rest].trim()) rest++;
    return finalNewline(
      [
        ...lines.slice(0, heading + 1),
        "",
        ...block.split("\n"),
        ...lines.slice(rest),
      ].join("\n"),
    );
  }
  const before = text.trimEnd();
  return `${before}${before ? "\n\n" : ""}## Compatibility\n\n${block}`;
}

/** What sync writes for the documentation: each qualifying package's README and the caller's `docs-files` lines. */
export interface DocsPlan {
  readmes: { path: string; current: string | undefined; content: string }[];
  docsFiles: string[];
  errors: string[];
  /** Whether a path relative to the repository root exists, for keeping hand-listed `docs-files` entries. */
  exists: (path: string) => boolean;
}

function relative(directory: string, name: string): string {
  return directory ? `${directory}/${name}` : name;
}

function isDirectory(root: string, path: string): boolean {
  return (
    statSync(join(root, path), { throwIfNoEntry: false })?.isDirectory() ===
    true
  );
}

function subdirectories(root: string, directory: string): string[] {
  return readdirSync(join(root, directory), { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        entry.name !== "node_modules" &&
        !entry.name.startsWith("."),
    )
    .map((entry) => relative(directory, entry.name));
}

function descendants(root: string, directory: string): string[] {
  return subdirectories(root, directory).flatMap((child) => [
    child,
    ...descendants(root, child),
  ]);
}

function globExpression(pattern: string): RegExp {
  const source = pattern
    .split("/")
    .map((segment) =>
      segment === "**"
        ? "(?:.*)"
        : segment
            .replace(/[.+^${}()|[\]\\]/g, "\\$&")
            .replaceAll("*", "[^/]*")
            .replaceAll("?", "[^/]"),
    )
    .join("/")
    .replaceAll("(?:.*)/", "(?:.*/)?");
  return new RegExp(`^${source}$`);
}

function expand(root: string, pattern: string): string[] {
  let directories = [""];
  for (const segment of pattern.split("/")) {
    if (segment === "**")
      directories = directories.flatMap((directory) => [
        directory,
        ...descendants(root, directory),
      ]);
    else if (/[*?]/.test(segment)) {
      const expression = globExpression(segment);
      directories = directories.flatMap((directory) =>
        subdirectories(root, directory).filter((child) =>
          expression.test(child.slice(child.lastIndexOf("/") + 1)),
        ),
      );
    } else
      directories = directories
        .map((directory) => relative(directory, segment))
        .filter((directory) => isDirectory(root, directory));
  }
  return directories;
}

function normalizePattern(pattern: string): string {
  return pattern
    .replace(/^(?:\.\/)+/, "")
    .replace(/\/+$/, "")
    .replace(/^\.$/, "");
}

function scalarItems(document: Document, path: string[]): string[] {
  const node = document.getIn(path, true);
  return isSeq(node)
    ? node.items.flatMap((item) => (isScalar(item) ? [String(item.value)] : []))
    : [];
}

/** pnpm-workspace.yaml `packages`, else package.json `workspaces` as an array or as `{ packages }`; JSON parses as YAML. */
function workspacePatterns(root: string): string[] {
  const pnpm = join(root, "pnpm-workspace.yaml");
  if (existsSync(pnpm))
    return scalarItems(parseDocument(readFileSync(pnpm, "utf8")), ["packages"]);
  const manifest = parseDocument(
    readFileSync(join(root, "package.json"), "utf8"),
  );
  return scalarItems(
    manifest,
    isMap(manifest.get("workspaces", true))
      ? ["workspaces", "packages"]
      : ["workspaces"],
  );
}

function workspaceDirectories(root: string): string[] {
  const patterns = workspacePatterns(root);
  const excluded = patterns
    .filter((pattern) => pattern.startsWith("!"))
    .map((pattern) => globExpression(normalizePattern(pattern.slice(1))));
  const found = new Set<string>();
  for (const pattern of patterns.filter((item) => !item.startsWith("!"))) {
    const normalized = normalizePattern(pattern);
    for (const directory of normalized ? expand(root, normalized) : [""])
      if (
        directory &&
        !excluded.some((expression) => expression.test(directory)) &&
        existsSync(join(root, directory, "package.json"))
      )
        found.add(directory);
  }
  return [...found].sort();
}

function declaredRanges(manifest: Manifest): Map<string, string> {
  const ranges = new Map<string, string>();
  for (const field of [
    manifest.optionalDependencies,
    manifest.dependencies,
    manifest.peerDependencies,
  ])
    for (const [name, range] of Object.entries(field ?? {}))
      if (name.startsWith(SCOPE)) ranges.set(name, range);
  return ranges;
}

function readManifest(root: string, directory: string): Manifest {
  return parseManifest(
    readFileSync(join(root, directory, "package.json"), "utf8"),
  );
}

function linkedVersion(
  root: string,
  directory: string,
  link: string,
): string | undefined {
  const target = join(root, directory, link);
  return existsSync(join(target, "package.json"))
    ? parseManifest(readFileSync(join(target, "package.json"), "utf8")).version
    : undefined;
}

function resolvedVersion(
  root: string,
  lock: Document,
  directory: string,
  name: string,
): string | undefined {
  const importer = directory || ".";
  for (const section of RESOLVED_SECTIONS) {
    const entry = lock.getIn(["importers", importer, section, name], true);
    const version = isMap(entry) ? entry.get("version", true) : entry;
    if (!isScalar(version)) continue;
    const resolved = String(version.value).split("(")[0];
    return resolved.startsWith("link:")
      ? linkedVersion(root, directory, resolved.slice("link:".length))
      : resolved;
  }
  return undefined;
}

function readLock(root: string): Document | undefined {
  const path = join(root, LOCKFILE);
  return existsSync(path)
    ? parseDocument(readFileSync(path, "utf8"))
    : undefined;
}

/**
 * Plans the docs-compat block of the root and of every workspace package that is not private and declares an
 * `@antelopejs/*` peer, runtime or optional dependency, and the `docs-files` lines covering the root and every workspace
 * package that is not private.
 * Tested with comes from pnpm-lock.yaml; other package managers get a dash.
 */
export function planDocs(root: string, manager: PackageManager): DocsPlan {
  const rootManifest = readManifest(root, "");
  const packages = ["", ...workspaceDirectories(root)].map((directory) => {
    const manifest = directory ? readManifest(root, directory) : rootManifest;
    return {
      directory,
      published: !directory || !manifest.private,
      ranges: manifest.private
        ? new Map<string, string>()
        : declaredRanges(manifest),
    };
  });
  const qualifying = packages.filter(({ ranges }) => ranges.size > 0);
  const plan: DocsPlan = {
    readmes: [],
    docsFiles: [],
    errors: [],
    exists: (path) => existsSync(join(root, path)),
  };
  const lock = manager === "pnpm" ? readLock(root) : undefined;
  if (manager === "pnpm" && qualifying.length && !lock) {
    plan.errors.push(
      `${LOCKFILE} is missing, and the docs-compat block reads Tested with from it: run pnpm install, then rerun antelopejs-sync.`,
    );
    return plan;
  }
  for (const { directory, ranges, published } of packages) {
    const readme = relative(directory, "README.md");
    const docs = relative(directory, "docs");
    const generated = ranges.size > 0;
    if (!published) continue;
    if (generated || existsSync(join(root, readme)))
      plan.docsFiles.push(readme);
    if (isDirectory(root, docs)) plan.docsFiles.push(docs);
    if (!generated) continue;
    const rows = [...ranges].map(([name, supported]) => ({
      name,
      supported,
      tested: lock && resolvedVersion(root, lock, directory, name),
    }));
    const current = existsSync(join(root, readme))
      ? readFileSync(join(root, readme), "utf8")
      : undefined;
    try {
      plan.readmes.push({
        path: readme,
        current,
        content: placeCompatBlock(current, compatBlock(rows)),
      });
    } catch (error) {
      plan.errors.push(
        `${readme}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return plan;
}
