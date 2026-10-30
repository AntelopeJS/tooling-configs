import { spawnSync } from "node:child_process";

import { readCeilings, type Ceilings } from "./ceilings.ts";

/**
 * Renames git detects, as new path to old path. Without `revisions` it
 * compares the index with HEAD when `staged`, otherwise the working tree with
 * HEAD; with revisions it compares those. Copies are never reported, and a
 * repository without HEAD has no renames.
 */
export function renamedPaths(
  root: string,
  staged = false,
  revisions: string[] = staged ? [] : ["HEAD"],
): Map<string, string> {
  const result = spawnSync(
    "git",
    [
      "diff",
      "--find-renames",
      "--diff-filter=R",
      "--name-status",
      "-z",
      "--no-ext-diff",
      ...(staged ? ["--cached"] : []),
      ...revisions,
      "--",
    ],
    { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  const renames = new Map<string, string>();
  if (result.error || result.status !== 0) return renames;
  const fields = result.stdout.split("\0");
  for (let index = 0; index + 2 < fields.length; index += 3)
    renames.set(fields[index + 2], fields[index + 1]);
  return renames;
}

/**
 * Moves the oversize allowance of each renamed file to its new path. The new
 * path never gets more than the old allowance; a copy or a new file has no
 * rename entry and so inherits nothing.
 */
function carryAllowances(
  ceilings: Ceilings,
  renames: Map<string, string>,
): Ceilings {
  const oversizeFiles = { ...ceilings.oversizeFiles };
  const moved: [string, number][] = [];
  for (const [file, previous] of renames) {
    const allowance = ceilings.oversizeFiles[previous];
    if (allowance === undefined) continue;
    delete oversizeFiles[previous];
    moved.push([
      file,
      Math.min(allowance, ceilings.oversizeFiles[file] ?? allowance),
    ]);
  }
  for (const [file, allowance] of moved) oversizeFiles[file] = allowance;
  return { ...ceilings, oversizeFiles };
}

/** The ceilings at `root` with allowances carried across the renames in `staged` or working-tree scope. */
export function readCarriedCeilings(
  root: string,
  staged = false,
  revisions?: string[],
): Ceilings {
  const ceilings = readCeilings(root);
  if (Object.keys(ceilings.oversizeFiles).length === 0) return ceilings;
  return carryAllowances(ceilings, renamedPaths(root, staged, revisions));
}
