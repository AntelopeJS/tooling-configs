import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import { stampProof } from "./proof-stamp.ts";
import { compareRevisions, revisionCounts } from "./revisions.ts";
import {
  emitPackage,
  extendedConfigs,
  listsNoFiles,
  packagesAt,
} from "./typescript.ts";

type TrackedPackage = ReturnType<typeof packagesAt>[number];

/** A private repository root whose `tsconfig.json` parses to no inputs and is extended by another tracked package: the base its packages extend, which compiles nothing on its own. */
function isWorkspaceBase(
  worktree: string,
  { directory, manifest }: TrackedPackage,
  tracked: TrackedPackage[],
): boolean {
  if (directory !== "." || manifest.private !== true) return false;
  const base = resolve(worktree, "tsconfig.json");
  return (
    listsNoFiles(worktree) &&
    tracked.some(
      (other) =>
        other.directory !== "." &&
        extendedConfigs(join(worktree, other.directory)).includes(base),
    )
  );
}

/** Proves comment-free JavaScript emit matches, including private packages and excluding tests. A workspace base tsconfig is left out. */
export function commentProof(root: string, baseRef: string) {
  const notices = new Set<string>();
  const result = compareRevisions(
    root,
    baseRef,
    "Comment proof",
    (worktree, output, scratch) => {
      const tracked = packagesAt(worktree, false);
      const packages = tracked.filter(
        (candidate) => !isWorkspaceBase(worktree, candidate, tracked),
      );
      let entries = 0;
      for (const { directory } of packages) {
        const key = directory === "." ? "_root" : directory;
        const emittedRoot = join(scratch, key);
        const emitted = emitPackage(
          join(worktree, directory),
          emittedRoot,
          false,
        );
        if (emitted.notice !== undefined) notices.add(emitted.notice);
        for (const file of emitted.files) {
          const path = join(output, key, relative(emittedRoot, file));
          mkdirSync(dirname(path), { recursive: true });
          copyFileSync(file, path);
          entries++;
        }
      }
      return { packages: packages.map(({ directory }) => directory), entries };
    },
  );
  return {
    ...result,
    output: stampProof(
      root,
      `antelopejs-comment-proof ${baseRef}`,
      baseRef,
      result.output +
        [...notices].sort().join("") +
        revisionCounts(root, baseRef),
    ),
  };
}
