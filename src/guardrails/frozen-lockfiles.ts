import { existsSync } from "node:fs";
import { join, posix } from "node:path";

import { workspaceDirectories } from "./docs-compat.ts";
import { runCommand } from "./run-command.ts";
import { pnpmLockfiles } from "./singleton-packages.ts";

const PNPM_WORKSPACE = "pnpm-workspace.yaml";

/** A folder pnpm installs from its own `pnpm-lock.yaml`, and whether it is a workspace of its own or a project installed apart from the workspace around it. */
interface InstallRoot {
  folder: string;
  workspace: boolean;
}

/** The nearest folder above `folder`, up to the repository root, that holds a `pnpm-workspace.yaml`, which pnpm takes as the workspace `folder` belongs to. */
function enclosingWorkspace(root: string, folder: string): string | undefined {
  for (let above = folder; above !== ".";) {
    above = posix.dirname(above);
    if (existsSync(join(root, above, PNPM_WORKSPACE))) return above;
  }
  return undefined;
}

function installRoot(root: string, folder: string): InstallRoot | undefined {
  if (existsSync(join(root, folder, PNPM_WORKSPACE)))
    return { folder, workspace: true };
  const workspace = enclosingWorkspace(root, folder);
  const member =
    workspace !== undefined &&
    workspaceDirectories(join(root, workspace)).includes(
      posix.relative(workspace, folder),
    );
  return member ? undefined : { folder, workspace: false };
}

/** The folders of the repository's `pnpm-lock.yaml` files that pnpm installs from: each holds a `pnpm-workspace.yaml` or is no member of the workspace around it, whose lockfile holds it instead. */
export function installRoots(root: string): InstallRoot[] {
  return pnpmLockfiles(root).flatMap((lockfile) => {
    const found = installRoot(root, posix.dirname(lockfile));
    return found ? [found] : [];
  });
}

async function frozenFailure(
  root: string,
  { folder, workspace }: InstallRoot,
  signal: AbortSignal | undefined,
): Promise<string> {
  const result = await runCommand(
    "pnpm",
    [
      "install",
      "--frozen-lockfile",
      "--lockfile-only",
      "--ignore-scripts",
      ...(workspace ? [] : ["--ignore-workspace"]),
    ],
    { cwd: join(root, folder), signal },
  );
  if (result.status === 0) return "";
  return `${posix.join(folder, "pnpm-lock.yaml")} is out of date with its manifests: run pnpm --dir ${folder} install --lockfile-only and commit it\n${result.output.trimEnd()}\n`;
}

/**
 * Fails when a lockfile pnpm installs from, one of {@link installRoots}, no longer matches its manifests: runs
 * `pnpm install --frozen-lockfile --lockfile-only --ignore-scripts` in each folder, with `--ignore-workspace` in a folder
 * that holds no `pnpm-workspace.yaml`, so pnpm reads that folder's lockfile and not the enclosing workspace's. Writes no
 * file. Returns what failed, empty when every lockfile matches.
 */
export async function checkFrozenLockfiles(
  root: string,
  signal: AbortSignal | undefined,
): Promise<string> {
  const failures = await Promise.all(
    installRoots(root).map((found) => frozenFailure(root, found, signal)),
  );
  return failures.join("");
}
