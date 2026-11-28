import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, posix } from "node:path";

import { workspaceDirectories } from "./docs-compat.ts";
import { runCommand } from "./run-command.ts";
import { pnpmLockfiles } from "./singleton-packages.ts";

const PNPM_WORKSPACE = "pnpm-workspace.yaml";
const PNPM_LOCK = "pnpm-lock.yaml";

/** A folder pnpm installs from its own `pnpm-lock.yaml`, and whether it is a workspace of its own or a project installed apart from the workspaces around it. */
interface FrozenLockRoot {
  folder: string;
  workspace: boolean;
}

/** The folders above `folder`, nearest first, up to the repository root `.`. */
function ancestors(folder: string): string[] {
  const found: string[] = [];
  let above = folder;
  while (above !== ".") {
    above = posix.dirname(above);
    found.push(above);
  }
  return found;
}

/** Whether a `pnpm-workspace.yaml` above `folder` lists it, so that workspace's lockfile holds it. */
function workspaceMember(root: string, folder: string): boolean {
  return ancestors(folder).some(
    (above) =>
      existsSync(join(root, above, PNPM_WORKSPACE)) &&
      workspaceDirectories(join(root, above)).includes(
        posix.relative(above, folder),
      ),
  );
}

/** The folders of the repository's `pnpm-lock.yaml` files that pnpm installs from: each holds a `pnpm-workspace.yaml`, or no workspace around it lists it. */
export function frozenLockRoots(root: string): FrozenLockRoot[] {
  return pnpmLockfiles(root).flatMap<FrozenLockRoot>((lockfile) => {
    const folder = posix.dirname(lockfile);
    if (existsSync(join(root, folder, PNPM_WORKSPACE)))
      return [{ folder, workspace: true }];
    return workspaceMember(root, folder) ? [] : [{ folder, workspace: false }];
  });
}

async function frozenFailure(
  root: string,
  { folder, workspace }: FrozenLockRoot,
  signal: AbortSignal | undefined,
): Promise<string> {
  const lockfile = join(root, folder, PNPM_LOCK);
  const before = readFileSync(lockfile);
  const result = await runCommand(
    "pnpm",
    [
      "install",
      "--frozen-lockfile",
      "--lockfile-only",
      "--ignore-scripts",
      "--reporter=append-only",
      ...(workspace ? [] : ["--ignore-workspace"]),
    ],
    { cwd: join(root, folder), signal },
  );
  if (existsSync(lockfile) && !before.equals(readFileSync(lockfile)))
    writeFileSync(lockfile, before);
  const output = `${result.output.trimEnd()}\n`;
  if (result.status === 0) return "";
  if (result.status === null)
    return `could not run pnpm in ${folder}:\n${output}`;
  return `${posix.join(folder, PNPM_LOCK)} is out of date with its manifests: run pnpm --dir ${folder} install --lockfile-only and commit it\n${output}`;
}

/**
 * Fails when a lockfile pnpm installs from, one of {@link frozenLockRoots}, no longer matches its manifests: runs
 * `pnpm install --frozen-lockfile --lockfile-only --ignore-scripts` in each folder, with `--ignore-workspace` in a folder
 * that holds no `pnpm-workspace.yaml`, so pnpm reads that folder's lockfile and not the enclosing workspace's. pnpm runs
 * at the version a folder's `packageManager` pins. Puts back the bytes of a lockfile pnpm rewrote, so a run leaves every
 * file as it found it. Returns what failed, empty when every lockfile matches.
 */
export async function checkFrozenLockfiles(
  root: string,
  signal: AbortSignal | undefined,
): Promise<string> {
  const failures = await Promise.all(
    frozenLockRoots(root).map((found) => frozenFailure(root, found, signal)),
  );
  return failures.join("");
}
