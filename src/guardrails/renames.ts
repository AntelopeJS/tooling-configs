import { spawnSync } from "node:child_process";

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
