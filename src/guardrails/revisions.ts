import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

import { resolveRevision, trackedManifests } from "./files.ts";
import { parseManifest, type Manifest } from "./package.ts";
import {
  countSuppressions,
  revisionSuppressions,
  type SuppressionCounts,
} from "./suppressions.ts";
import {
  applyAllowance,
  type AddedPolicy,
  type PublishedEntry,
} from "./added-entries.ts";

export const DIRECTORY_LINK = process.platform === "win32" ? "junction" : "dir";

/** The parsed manifest of each tracked package of `checkout`, keyed by its directory; an unreadable manifest is left out. */
export function workspaceManifests(checkout: string): Map<string, Manifest> {
  const manifests = new Map<string, Manifest>();
  for (const file of trackedManifests(checkout))
    try {
      manifests.set(
        dirname(file),
        parseManifest(readFileSync(join(checkout, file), "utf8")),
      );
    } catch {
      continue;
    }
  return manifests;
}

/** Maps each named package directory of the checkout to its package in `worktree`: the same directory when it holds a package of that name, otherwise the only package of that name. */
function ownPackages(root: string, worktree: string): Map<string, string> {
  const atRevision = workspaceManifests(worktree);
  const byName = new Map<string, string[]>();
  for (const [directory, { name }] of atRevision)
    if (name !== undefined)
      byName.set(name, [...(byName.get(name) ?? []), directory]);
  const packages = new Map<string, string>();
  for (const [directory, { name }] of workspaceManifests(root)) {
    if (name === undefined) continue;
    const named = byName.get(name) ?? [];
    if (atRevision.get(directory)?.name === name)
      packages.set(directory, directory);
    else if (named.length === 1) packages.set(directory, named[0]);
  }
  return packages;
}

/** The worktree path standing in for `real`, a path relative to the checkout, when it is a workspace package of the checkout or lies inside one other than the root package, and the revision has a package of that name. */
function ownCopy(
  real: string,
  packages: Map<string, string>,
): string | undefined {
  const posix = real.split(sep).join("/") || ".";
  if (
    isAbsolute(real) ||
    posix.split("/").some((part) => part === ".." || part === "node_modules")
  )
    return undefined;
  const owner = [...packages.keys()]
    .filter(
      (directory) => posix === directory || posix.startsWith(`${directory}/`),
    )
    .sort((a, b) => b.length - a.length)[0];
  return owner === undefined
    ? undefined
    : join(packages.get(owner) ?? owner, posix.slice(owner.length));
}

interface Installed {
  root: string;
  realRoot: string;
  worktree: string;
  packages: Map<string, string>;
}

/** Mirrors `path`, a `node_modules`, scope or `.bin` directory of the checkout, into the worktree entry by entry: an entry whose real location is a workspace package of the checkout links to the worktree's package of that name, and every other entry to the checkout's installed one. */
function mirrorInstalled(installed: Installed, path: string): void {
  const { root, realRoot, worktree, packages } = installed;
  mkdirSync(join(worktree, path));
  for (const entry of readdirSync(join(root, path))) {
    const source = join(root, path, entry);
    const target = join(worktree, path, entry);
    if (
      !existsSync(source) ||
      lstatSync(target, { throwIfNoEntry: false }) !== undefined
    )
      continue;
    const directory = statSync(source).isDirectory();
    if (directory && (entry === ".bin" || entry.startsWith("@"))) {
      mirrorInstalled(installed, join(path, entry));
      continue;
    }
    const real = realpathSync.native(source);
    const own = ownCopy(relative(realRoot, real), packages);
    const type = directory ? DIRECTORY_LINK : "file";
    if (own !== undefined) symlinkSync(join(worktree, own), target, type);
    else if (directory) symlinkSync(source, target, DIRECTORY_LINK);
    else if (lstatSync(source).isSymbolicLink())
      symlinkSync(real, target, type);
    else copyFileSync(source, target);
  }
}

/** Links the checkout's installed dependencies into `worktree`; with `ownWorkspace`, a dependency on a workspace package resolves to the worktree's own revision of it instead of the checkout's. */
function linkDependencies(
  root: string,
  worktree: string,
  ownWorkspace: boolean,
): void {
  const directories = new Set([".", ...trackedManifests(root).map(dirname)]);
  const installed = {
    root,
    realRoot: realpathSync.native(root),
    worktree,
    packages: ownWorkspace ? ownPackages(root, worktree) : new Map(),
  };
  for (const directory of directories) {
    const path = join(directory, "node_modules");
    if (
      !existsSync(join(root, path)) ||
      !existsSync(join(worktree, directory)) ||
      lstatSync(join(worktree, path), { throwIfNoEntry: false }) !== undefined
    )
      continue;
    if (ownWorkspace) mirrorInstalled(installed, path);
    else symlinkSync(join(root, path), join(worktree, path), DIRECTORY_LINK);
  }
}

interface RevisionOutput {
  packages: string[];
  entries: number;
  published?: PublishedEntry[];
}

interface CompareOptions {
  policy?: AddedPolicy;
  /** Each worktree resolves its workspace packages to its own revision, for a comparison that builds them there. */
  ownWorkspace?: boolean;
  /** Rewrites one side's output directory after allowed additions are removed and before the sides are compared. */
  collate?: (output: string) => void;
}

/** Compares isolated committed revisions and removes both worktrees even when compilation fails; a policy lets matching `@internal` additions through. */
export function compareRevisions(
  root: string,
  baseRef: string,
  label: string,
  emit: (worktree: string, output: string, scratch: string) => RevisionOutput,
  { policy, ownWorkspace = false, collate }: CompareOptions = {},
) {
  const temporary = mkdtempSync(join(tmpdir(), "antelope-proof-"));
  const worktrees: string[] = [];
  const results: RevisionOutput[] = [];
  try {
    for (const [side, ref] of [
      ["base", baseRef],
      ["head", "HEAD"],
    ]) {
      const revision = execFileSync(
        "git",
        ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`],
        { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      ).trim();
      const worktree = join(temporary, "worktrees", side);
      execFileSync(
        "git",
        ["worktree", "add", "--quiet", "--detach", worktree, revision],
        {
          cwd: root,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      worktrees.push(worktree);
      linkDependencies(root, worktree, ownWorkspace);
      const output = join(temporary, side);
      mkdirSync(output, { recursive: true });
      results.push(emit(worktree, output, join(temporary, "emit", side)));
    }
    const allowedAdditions =
      policy === undefined
        ? 0
        : applyAllowance(
            policy,
            results[0].published ?? [],
            results[1].published ?? [],
            (path) => rmSync(join(temporary, "head", path), { force: true }),
          );
    if (collate !== undefined)
      for (const side of ["base", "head"]) collate(join(temporary, side));
    const diff = spawnSync(
      "git",
      [
        "diff",
        "--no-index",
        "--no-color",
        "--no-renames",
        "--no-ext-diff",
        "--no-textconv",
        "--",
        "base",
        "head",
      ],
      {
        cwd: temporary,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      },
    );
    if (diff.error) throw diff.error;
    if (diff.status !== 0 && diff.status !== 1)
      throw new Error(diff.stderr || "Could not compare revision outputs.");
    const packages = new Set(results.flatMap((result) => result.packages)).size;
    return {
      different: diff.status === 1,
      output:
        diff.status === 1
          ? `${label}: differences against ${baseRef} (committed HEAD).\n${diff.stdout}`
          : `${label}: ${packages} packages, ${results[1].entries - allowedAdditions} entries unchanged against ${baseRef} (committed HEAD).\n`,
    };
  } finally {
    for (const worktree of worktrees.reverse())
      execFileSync("git", ["worktree", "remove", "--force", worktree], {
        cwd: root,
        stdio: "pipe",
      });
    rmSync(temporary, { recursive: true, force: true });
  }
}

function countRows(base: SuppressionCounts, head: SuppressionCounts) {
  const total = (counts: SuppressionCounts) =>
    Object.values(counts.rules).reduce((sum, count) => sum + count, 0);
  const rules = [
    ...new Set([...Object.keys(base.rules), ...Object.keys(head.rules)]),
  ].sort((a, b) => a.localeCompare(b));
  const configTotal = (counts: SuppressionCounts) =>
    Object.values(counts.config ?? {}).reduce((sum, count) => sum + count, 0);
  const configRules = [
    ...new Set([
      ...Object.keys(base.config ?? {}),
      ...Object.keys(head.config ?? {}),
    ]),
  ].sort((a, b) => a.localeCompare(b));
  return [
    ["Lint suppressions, all rules", total(base), total(head)],
    ...rules.map((rule) => [
      `Lint suppressions, \`${rule}\``,
      base.rules[rule] ?? 0,
      head.rules[rule] ?? 0,
    ]),
    ["`@ts-expect-error`", base.tsExpectError, head.tsExpectError],
    ["`@ts-ignore`", base.tsIgnore, head.tsIgnore],
    ["`SAFETY:` comments", base.safety, head.safety],
    ["Lint config rule-offs, all rules", configTotal(base), configTotal(head)],
    ...configRules.map((rule) => [
      `Lint config rule-offs, \`${rule}\``,
      base.config?.[rule] ?? 0,
      head.config?.[rule] ?? 0,
    ]),
  ];
}

/** The suppression table rows, `| label | base | head |`, counted in authored code files at both revisions with the shared suppression counter. */
export function revisionCountRows(
  root: string,
  baseRef: string,
  headRef = "HEAD",
): string[] {
  const [base, head] = [baseRef, headRef].map((ref) =>
    countSuppressions(revisionSuppressions(root, resolveRevision(root, ref))),
  );
  return countRows(base, head).map(
    ([label, before, after]) => `| ${label} | ${before} | ${after} |`,
  );
}

/** Counts suppressions in authored code files at the base and at committed HEAD, so a PR body copies them instead of typing them. */
export function revisionCounts(root: string, baseRef: string): string {
  const rows = revisionCountRows(root, baseRef);
  return `\nSuppressions in authored code files (${baseRef} and committed HEAD). A lint directive counts once per rule it names; \`*\` is a directive naming none.\n| Suppressions | base | HEAD |\n| --- | ---: | ---: |\n${rows.join("\n")}\n`;
}
