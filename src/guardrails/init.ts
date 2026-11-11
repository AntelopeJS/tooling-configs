import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import {
  bootstrapDependencies,
  bootstrappedManifest,
  packageManager,
  parseManifest,
  toolingVersions,
  usesNuxt,
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
  /** The files `--init` wrote itself, before sync ran or in its oxfmt pass after. */
  paths: string[];
  /** The files `--init` deleted: npm's lockfile once pnpm's replaced it. */
  removed: string[];
  /** The output of the install or the oxfmt run that failed. Set before sync when the first install failed, after it otherwise. */
  failure: string | undefined;
  /** Undefined when the first install failed, so sync never ran. */
  sync: ReturnType<typeof syncRepository> | undefined;
  /** What GitHub holds for `delete_branch_on_merge`, whatever the file steps did. */
  branchCleanup: BranchCleanup;
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

/** Runs `manager` with `args` quietly; returns its output only when it failed. */
function run(
  root: string,
  manager: PackageManager,
  args: readonly string[],
): string | undefined {
  const command = [manager, ...args].join(" ");
  const result = spawnSync(manager, args, { cwd: root, encoding: "utf8" });
  if (result.error) return `${command} failed: ${result.error.message}`;
  if (result.status === 0) return undefined;
  return `${command} failed (exit ${result.status}).\n${result.stdout}${result.stderr}`.trimEnd();
}

function install(root: string, manager: PackageManager): string | undefined {
  return run(root, manager, ["install"]);
}

function resolveOxfmt(root: string): string {
  const require = createRequire(join(root, "package.json"));
  return join(dirname(require.resolve("oxfmt/package.json")), "bin/oxfmt");
}

interface Formatted {
  /** The files oxfmt listed as differing before it wrote them. */
  rewritten: string[];
  /** The output of an oxfmt run that failed. */
  failure: string | undefined;
}

/** Formats the repository with its installed oxfmt, as its `format` script does, so `format:check` passes on the keys init and sync append out of order and on source the repository never formatted. */
function formatRepository(root: string): Formatted {
  let binary: string;
  try {
    binary = resolveOxfmt(root);
  } catch {
    return {
      rewritten: [],
      failure:
        "oxfmt is not installed in this repository, so it is not formatted.",
    };
  }
  const oxfmt = (flags: string[]) =>
    spawnSync(
      process.execPath,
      [binary, ...flags, "--no-error-on-unmatched-pattern", "."],
      { cwd: root, encoding: "utf8" },
    );
  const rewritten = oxfmt(["--list-different"])
    .stdout.split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const result = oxfmt([]);
  if (result.error)
    return { rewritten, failure: `oxfmt failed: ${result.error.message}` };
  if (result.status === 0) return { rewritten, failure: undefined };
  return {
    rewritten,
    failure:
      `oxfmt failed (exit ${result.status}).\n${result.stdout}${result.stderr}`.trimEnd(),
  };
}

/** The tsconfig `--init` writes for a Node repository with none, so the synced `typecheck` checks its JavaScript and TypeScript under Node's module rules. */
const NODE_TSCONFIG = `{
  "compilerOptions": {
    "target": "ES2024",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "allowJs": true,
    "checkJs": true,
    "strict": true,
    "noEmit": true,
    "types": ["node"]
  }
}
`;

const NPM_LOCKFILE = "package-lock.json";

interface Bootstrap {
  manager: PackageManager;
  paths: string[];
  removed: string[];
  failure: string | undefined;
}

/**
 * The file steps before the first install: `node_modules` ignored, the pnpm version the pack's CI runs pinned when
 * `packageManager` is unset, the bootstrap devDependencies, a tsconfig for a Node repository without one or its own
 * `typecheck`, and npm's lockfile replaced by a pnpm lockfile holding the versions it resolved.
 */
function bootstrap(root: string): Bootstrap {
  const path = join(root, "package.json");
  if (!existsSync(path))
    throw new Error(
      "package.json is missing. antelopejs-sync --init needs a repository that already has one.",
    );
  const current = readFileSync(path, "utf8");
  const manifest = parseManifest(current);
  const manager = packageManager(manifest);
  const versions = toolingVersions();
  const paths: string[] = [];
  if (ensureGitignore(root)) paths.push(".gitignore");
  const nodeProject =
    !existsSync(join(root, "tsconfig.json")) &&
    manifest.scripts?.typecheck === undefined &&
    !usesNuxt(root, manifest);
  const next = bootstrappedManifest(
    current,
    bootstrapDependencies(manifest, versions, nodeProject),
    versions.packageManager,
  );
  if (next !== current) {
    writeFileSync(path, next);
    paths.push("package.json");
  }
  if (nodeProject) {
    writeFileSync(join(root, "tsconfig.json"), NODE_TSCONFIG);
    paths.push("tsconfig.json");
  }
  const npmLock = manager === "pnpm" && existsSync(join(root, NPM_LOCKFILE));
  const imported =
    npmLock && !existsSync(join(root, "pnpm-lock.yaml"))
      ? run(root, manager, ["import"])
      : undefined;
  if (imported !== undefined)
    return { manager, paths, removed: [], failure: imported };
  if (npmLock) unlinkSync(join(root, NPM_LOCKFILE));
  return {
    manager,
    paths,
    removed: npmLock ? [NPM_LOCKFILE] : [],
    failure: install(root, manager),
  };
}

/**
 * Onboards a repository in one run: the bootstrap file steps and an install, a full-profile sync, a second install
 * when sync added devDependencies, the repository formatted by oxfmt, and `delete_branch_on_merge` on GitHub, which
 * runs whatever the file steps did. Every step is idempotent, so a second run changes nothing.
 */
export function initRepository(
  root: string,
  options: { verify?: VerifyChoice } = {},
): InitResult {
  const { manager, paths, removed, failure: first } = bootstrap(root);
  if (first !== undefined)
    return {
      paths,
      removed,
      failure: first,
      sync: undefined,
      branchCleanup: ensureBranchCleanup(root),
    };
  const sync = syncRepository(root, {
    profile: "full",
    verify: options.verify,
  });
  let failure: string | undefined;
  if (!sync.errors.length) {
    failure = sync.dependenciesAdded ? install(root, manager) : undefined;
    if (failure === undefined) {
      const formatted = formatRepository(root);
      failure = formatted.failure;
      for (const file of formatted.rewritten)
        if (!paths.includes(file)) paths.push(file);
    }
  }
  return {
    paths,
    removed,
    failure,
    sync,
    branchCleanup: ensureBranchCleanup(root),
  };
}
