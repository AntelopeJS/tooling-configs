import { execFileSync } from "node:child_process";

import { renamedPaths } from "./renames.ts";

/**
 * The line ranges each staged file adds against `revision`, HEAD when
 * omitted, following renames.
 */
export function stagedAdditions(
  root: string,
  targets: string[],
  revision?: string,
): Map<string, { start: number; end: number }[]> {
  const revisions = revision === undefined ? [] : [revision];
  const renames = renamedPaths(root, true, revisions);
  const additions = new Map<string, { start: number; end: number }[]>();
  for (const file of targets) {
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
        ...[renames.get(file), file].filter((path) => path !== undefined),
      ],
      { cwd: root, encoding: "utf8" },
    );
    additions.set(
      file,
      Array.from(
        diff.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm),
        ([, line, count]) => ({
          start: Number(line),
          end: Number(line) + Number(count ?? 1) - 1,
        }),
      ),
    );
  }
  return additions;
}
