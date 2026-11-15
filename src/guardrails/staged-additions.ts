import { execFileSync } from "node:child_process";

import { renamedPaths } from "./renames.ts";

/** One `--unified=0` hunk of a staged file: the lines it removes, and the staged lines it adds from `start`. */
interface StagedHunk {
  removed: number;
  start: number;
  count: number;
}

/** A staged file's path at the compared revision and its hunks against it. */
interface StagedChanges {
  previous: string;
  hunks: StagedHunk[];
}

/**
 * Each staged file's path and hunks against `revision`, HEAD when omitted,
 * following renames.
 */
function stagedChanges(
  root: string,
  targets: string[],
  revision?: string,
): Map<string, StagedChanges> {
  const revisions = revision === undefined ? [] : [revision];
  const renames = renamedPaths(root, true, revisions);
  const changes = new Map<string, StagedChanges>();
  for (const file of targets) {
    const previous = renames.get(file) ?? file;
    const diff = execFileSync(
      "git",
      [
        "diff",
        "--cached",
        ...revisions,
        "--no-ext-diff",
        "--no-color",
        "--unified=0",
        "--find-renames",
        "--",
        ...new Set([previous, file]),
      ],
      { cwd: root, encoding: "utf8" },
    );
    changes.set(file, {
      previous,
      hunks: Array.from(
        diff.matchAll(/^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm),
        ([, removed, start, count]) => ({
          removed: Number(removed ?? 1),
          start: Number(start),
          count: Number(count ?? 1),
        }),
      ),
    });
  }
  return changes;
}

/**
 * The line ranges each staged file adds against `revision`, HEAD when
 * omitted, following renames.
 */
export function stagedAdditions(
  root: string,
  targets: string[],
  revision?: string,
): Map<string, { start: number; end: number }[]> {
  return new Map(
    Array.from(stagedChanges(root, targets, revision), ([file, { hunks }]) => [
      file,
      hunks.map(({ start, count }) => ({ start, end: start + count - 1 })),
    ]),
  );
}
