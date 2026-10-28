import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

import { parseManifest, type Manifest } from "./package.ts";

const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;

function readManifest(directory: string): Manifest | undefined {
  const file = join(directory, "package.json");
  return existsSync(file)
    ? parseManifest(readFileSync(file, "utf8"))
    : undefined;
}

function declares(manifest: Manifest | undefined): boolean {
  return DEPENDENCY_FIELDS.some(
    (field) => manifest?.[field]?.typescript !== undefined,
  );
}

/** The nearest manifest at or above `directory` that configures a workspace, never leaving the repository that contains it. */
function workspaceManifest(directory: string): Manifest | undefined {
  for (let current = directory; ; current = dirname(current)) {
    const manifest = readManifest(current);
    if (
      manifest !== undefined &&
      (manifest.workspaces !== undefined ||
        existsSync(join(current, "pnpm-workspace.yaml")))
    )
      return manifest;
    if (existsSync(join(current, ".git")) || dirname(current) === current)
      return undefined;
  }
}

/** Whether the package at `directory`, or the workspace root above it, declares `typescript` as a dependency of any kind. */
export function declaresTypeScript(directory: string): boolean {
  return (
    declares(readManifest(directory)) || declares(workspaceManifest(directory))
  );
}

/** The directory of the package relative to the repository that contains it, `.` for the repository root; the same for every revision of the repository. */
export function repositoryDirectory(directory: string): string {
  for (let current = directory; ; current = dirname(current)) {
    if (existsSync(join(current, ".git")) || dirname(current) === current)
      return relative(current, directory).split("\\").join("/") || ".";
  }
}

/** The package as an error names it: its `name` when it has one, and its directory. */
export function describePackage(directory: string): string {
  const name = readManifest(directory)?.name;
  const where = repositoryDirectory(directory);
  return name === undefined ? where : `${name} (${where})`;
}
