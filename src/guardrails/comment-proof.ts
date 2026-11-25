import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

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

/** The first base a package's tsconfig extends that lies inside the repository but is absent from the commit, such as a generated file, as a repository path. */
function uncommittedBase(worktree: string, directory: string) {
  const missing = extendedConfigs(join(worktree, directory)).find(
    (file) => !existsSync(file),
  );
  if (missing === undefined) return undefined;
  const path = relative(worktree, missing);
  return path.startsWith(`..${sep}`) || isAbsolute(path)
    ? undefined
    : path.split(sep).join("/");
}

/** Proves comment-free JavaScript emit matches, including private packages and excluding tests. A workspace base tsconfig is left out. A package whose tsconfig extends a repository file the commit lacks cannot compile from it, so it is skipped and reported; a missing base outside the repository still fails, and so does a head side that compares 0 entries. */
export function commentProof(root: string, baseRef: string) {
  const skipped = new Map<string, string>();
  let headEntries = 0;
  const result = compareRevisions(
    root,
    baseRef,
    "Comment proof",
    (worktree, output, scratch) => {
      const tracked = packagesAt(worktree, false);
      const packages = tracked.filter((candidate) => {
        const base = uncommittedBase(worktree, candidate.directory);
        if (base !== undefined) skipped.set(candidate.directory, base);
        return (
          base === undefined && !isWorkspaceBase(worktree, candidate, tracked)
        );
      });
      let entries = 0;
      for (const { directory } of packages) {
        const key = directory === "." ? "_root" : directory;
        const emittedRoot = join(scratch, key);
        const emitted = emitPackage(
          join(worktree, directory),
          emittedRoot,
          false,
        );
        for (const file of emitted.files) {
          const path = join(output, key, relative(emittedRoot, file));
          mkdirSync(dirname(path), { recursive: true });
          copyFileSync(file, path);
          entries++;
        }
      }
      headEntries = entries;
      return { packages: packages.map(({ directory }) => directory), entries };
    },
  );
  const skips = [...skipped]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(
      ([directory, file]) =>
        `Comment proof: skipped ${directory}, its tsconfig extends ${file}, which the commit does not hold.\n`,
    )
    .join("");
  const empty = headEntries === 0;
  const emptyReport = empty
    ? `Comment proof: the head side compared 0 entries, so nothing was proved${skipped.size === 0 ? "" : `; skipped packages: ${[...skipped.keys()].sort((a, b) => a.localeCompare(b)).join(", ")}`}.\n`
    : "";
  return {
    different: result.different || empty,
    output: result.output + skips + emptyReport + revisionCounts(root, baseRef),
  };
}
