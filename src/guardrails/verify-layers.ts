import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { execCommand, type PackageManager } from "./package.ts";
import { runCommand } from "./run-command.ts";

const SKILLS_FOLDER = ".agents/skills";
const LAYER_PREFIX = "verify-";

/** The folder a repository's playground lives in; verify installs a fixture project from it. */
const PLAYGROUND = "playground";

const PNPM_OUTDATED = "ERR_PNPM_OUTDATED_LOCKFILE";
const NPM_OUT_OF_SYNC = "can only install packages when your package.json";

/** The lockfile names `antelopejs-checks` can replay, each with the package manager that owns it. */
const LOCKFILES = {
  "pnpm-lock.yaml": "pnpm",
  "package-lock.json": "npm",
} as const;

type LockfileName = keyof typeof LOCKFILES;

/** A lockfile verify installs from: the folder holding it, relative to the repository root, and its file name. */
export interface Lockfile {
  folder: string;
  file: LockfileName;
}

interface RunContext {
  root: string;
  signal: AbortSignal | undefined;
}

function isLockfileName(name: string): name is LockfileName {
  return Object.hasOwn(LOCKFILES, name);
}

/** The verify layers of a repository, relative to its root: each `.agents/skills/verify-*` folder that holds a `tsconfig.json` or a `verify.config.ts`. */
export function verifyLayers(root: string): string[] {
  const skills = join(root, SKILLS_FOLDER);
  if (!existsSync(skills)) return [];
  return readdirSync(skills, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        entry.name.startsWith(LAYER_PREFIX) &&
        ["tsconfig.json", "verify.config.ts"].some((file) =>
          existsSync(join(skills, entry.name, file)),
        ),
    )
    .map((entry) => `${SKILLS_FOLDER}/${entry.name}`)
    .sort();
}

function lockfilesIn(root: string, folder: string, deep: boolean): Lockfile[] {
  const found: Lockfile[] = [];
  const entries = existsSync(join(root, folder))
    ? readdirSync(join(root, folder), { withFileTypes: true })
    : [];
  for (const entry of entries) {
    if (entry.isFile() && isLockfileName(entry.name))
      found.push({ folder, file: entry.name });
    else if (deep && entry.isDirectory() && entry.name !== "node_modules")
      found.push(...lockfilesIn(root, `${folder}/${entry.name}`, deep));
  }
  return found;
}

/** Every lockfile verify installs from, when a layer exists: each one inside a layer, and the one in the root `playground` folder. */
export function verifyLockfiles(root: string): Lockfile[] {
  const layers = verifyLayers(root);
  if (layers.length === 0) return [];
  return [
    ...layers.flatMap((layer) => lockfilesIn(root, layer, true)),
    ...lockfilesIn(root, PLAYGROUND, false),
  ];
}

function execArguments(manager: PackageManager): [string, string[]] {
  const [command, ...rest] = execCommand(manager).split(" ");
  return [command, rest];
}

async function typecheckLayer(
  context: RunContext,
  manager: PackageManager,
  layer: string,
): Promise<string> {
  if (!existsSync(join(context.root, layer, "tsconfig.json")))
    return `${layer}: has a verify.config.ts and no tsconfig.json. Run antelopejs-sync, or add a tsconfig.json that includes its TypeScript files.\n`;
  const [command, prefix] = execArguments(manager);
  const result = await runCommand(
    command,
    [...prefix, "tsc", "--noEmit", "-p", `${layer}/tsconfig.json`],
    {
      cwd: context.root,
      env: { ...process.env, CI: "1" },
      signal: context.signal,
    },
  );
  return result.status === 0 ? "" : result.output;
}

/**
 * Type-checks each verify layer with the repository's own TypeScript, `tsc --noEmit -p <layer>/tsconfig.json`, since the root
 * tsconfig cannot include a layer: its `rootDir` is usually `src`. Returns the compiler output of the layers that fail, empty when all pass.
 */
export async function typecheckLayers(
  root: string,
  manager: PackageManager,
  signal?: AbortSignal,
): Promise<string> {
  const outputs = await Promise.all(
    verifyLayers(root).map((layer) =>
      typecheckLayer({ root, signal }, manager, layer),
    ),
  );
  return outputs.join("");
}

async function checkLockfile(
  context: RunContext,
  { folder, file }: Lockfile,
): Promise<string> {
  const manager = LOCKFILES[file];
  const args =
    manager === "pnpm"
      ? [
          "install",
          "--dir",
          join(context.root, folder),
          "--ignore-workspace",
          "--frozen-lockfile",
          "--lockfile-only",
          "--ignore-scripts",
        ]
      : ["ci", "--dry-run", "--ignore-scripts", "--no-audit", "--no-fund"];
  const result = await runCommand(manager, args, {
    cwd: manager === "pnpm" ? context.root : join(context.root, folder),
    env: { ...process.env, CI: "1" },
    signal: context.signal,
  });
  if (result.status === 0) return "";
  if (manager === "pnpm")
    return result.output.includes(PNPM_OUTDATED)
      ? `${folder}/${file} does not match ${folder}/package.json: run \`pnpm install --dir ${folder} --ignore-workspace --lockfile-only\`.\n`
      : `${folder}: pnpm could not check ${file}.\n${result.output}`;
  return result.output.includes(NPM_OUT_OF_SYNC)
    ? `${folder}/${file} does not match ${folder}/package.json: run \`npm install --package-lock-only --prefix ${folder}\`.\n${result.output}`
    : `${folder}: npm could not check ${file}.\n${result.output}`;
}

/**
 * Replays a frozen, lockfile-only install in every folder verify installs from: `pnpm install --frozen-lockfile --lockfile-only`
 * for a `pnpm-lock.yaml` and `npm ci --dry-run` for a `package-lock.json`. Neither writes a file or fetches a package.
 * Returns what failed, empty when every lockfile matches its `package.json`.
 */
export async function checkLockfiles(
  root: string,
  signal?: AbortSignal,
): Promise<string> {
  const outputs = await Promise.all(
    verifyLockfiles(root).map((lockfile) =>
      checkLockfile({ root, signal }, lockfile),
    ),
  );
  return outputs.join("");
}
