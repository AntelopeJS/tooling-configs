import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  bootstrapDependencies,
  packageManager,
  parseManifest,
  toolingVersions,
  withDevDependencies,
  type PackageManager,
} from "./package.ts";
import { syncRepository } from "./sync.ts";
import type { VerifyChoice } from "./verify-skill.ts";

/** The `gh` arguments that turn `delete_branch_on_merge` on; `gh` fills `{owner}/{repo}` from the git remote. */
const ENABLE_ARGS = [
  "api",
  "-X",
  "PATCH",
  "repos/{owner}/{repo}",
  "-F",
  "delete_branch_on_merge=true",
] as const;

/** The command a person runs when `--init` could not turn `delete_branch_on_merge` on. */
export const ENABLE_BRANCH_CLEANUP = `gh ${ENABLE_ARGS.join(" ")}`;

type BranchCleanup =
  | { kind: "on" }
  | { kind: "enabled" }
  | { kind: "unavailable"; reason: string };

export interface InitResult {
  /** The files `--init` wrote itself, before sync ran. */
  paths: string[];
  /** The output of the install that failed. Set before sync when the first install failed, after it when the second did. */
  installFailure: string | undefined;
  /** Undefined when the first install failed, so sync never ran. */
  sync: ReturnType<typeof syncRepository> | undefined;
  /** Undefined when sync did not finish cleanly. */
  branchCleanup: BranchCleanup | undefined;
}

const NODE_MODULES_LINE = /^(?:\*\*\/|\/)?node_modules\/?$/;

/** Creates `.gitignore` or appends `node_modules` to it, keeping every existing line; returns whether it wrote. */
function ensureGitignore(root: string): boolean {
  const path = join(root, ".gitignore");
  const current = existsSync(path) ? readFileSync(path, "utf8") : "";
  if (
    current.split(/\r?\n/).some((line) => NODE_MODULES_LINE.test(line.trim()))
  )
    return false;
  const newline = current.includes("\r\n") ? "\r\n" : "\n";
  const separator = current === "" || current.endsWith("\n") ? "" : newline;
  writeFileSync(path, `${current}${separator}node_modules${newline}`);
  return true;
}

function failureText(result: SpawnSyncReturns<string>): string {
  if (result.error)
    return "code" in result.error && result.error.code === "ENOENT"
      ? "gh is not installed"
      : result.error.message;
  return (
    result.stderr.trim().split("\n")[0] ||
    `gh exited with ${result.status ?? result.signal}`
  );
}

function gh(root: string, args: readonly string[]) {
  return spawnSync("gh", args, { cwd: root, encoding: "utf8" });
}

/** Turns `delete_branch_on_merge` on through `gh`, reading it first so a repository that has it on is never written. */
function ensureBranchCleanup(root: string): BranchCleanup {
  const read = gh(root, [
    "api",
    "repos/{owner}/{repo}",
    "--jq",
    ".delete_branch_on_merge",
  ]);
  if (read.error || read.status !== 0)
    return { kind: "unavailable", reason: failureText(read) };
  const state = read.stdout.trim();
  if (state === "true") return { kind: "on" };
  if (state !== "false")
    return {
      kind: "unavailable",
      reason: `gh answered ${JSON.stringify(state)}`,
    };
  const write = gh(root, ENABLE_ARGS);
  return write.error || write.status !== 0
    ? { kind: "unavailable", reason: failureText(write) }
    : { kind: "enabled" };
}

/** Runs the package manager's install quietly; returns its output only when it failed. */
function install(root: string, manager: PackageManager): string | undefined {
  const result = spawnSync(manager, ["install"], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.error) return `${manager} install failed: ${result.error.message}`;
  if (result.status === 0) return undefined;
  return `${manager} install failed (exit ${result.status}).\n${result.stdout}${result.stderr}`.trimEnd();
}

/**
 * Onboards a repository in one run: `node_modules` in `.gitignore`, the pack,
 * oxlint and oxfmt as devDependencies, an install, a full-profile sync, a second
 * install when sync added devDependencies, and `delete_branch_on_merge` on
 * GitHub. Every step is idempotent, so a second run changes nothing.
 */
export function initRepository(
  root: string,
  options: { verify?: VerifyChoice } = {},
): InitResult {
  const path = join(root, "package.json");
  if (!existsSync(path))
    throw new Error(
      "package.json is missing. antelopejs-sync --init needs a repository that already has one.",
    );
  const paths: string[] = [];
  if (ensureGitignore(root)) paths.push(".gitignore");
  const current = readFileSync(path, "utf8");
  const manifest = parseManifest(current);
  const added = bootstrapDependencies(manifest, toolingVersions());
  if (added.length) {
    writeFileSync(path, withDevDependencies(current, added));
    paths.push("package.json");
  }
  const manager = packageManager(manifest);
  const first = install(root, manager);
  if (first !== undefined)
    return {
      paths,
      installFailure: first,
      sync: undefined,
      branchCleanup: undefined,
    };
  const sync = syncRepository(root, {
    profile: "full",
    verify: options.verify,
  });
  const second =
    !sync.errors.length && sync.dependenciesAdded
      ? install(root, manager)
      : undefined;
  return {
    paths,
    installFailure: second,
    sync,
    branchCleanup:
      sync.errors.length || second !== undefined
        ? undefined
        : ensureBranchCleanup(root),
  };
}
