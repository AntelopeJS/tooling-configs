import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";

import { compareRevisions } from "./revisions.ts";
import { emitPackage, packagesAt } from "./typescript.ts";

/** Proves comment-free JavaScript emit matches, including private packages and excluding tests. */
export function commentProof(root: string, baseRef: string) {
  return compareRevisions(
    root,
    baseRef,
    "Comment proof",
    (worktree, output, scratch) => {
      const packages = packagesAt(worktree, false);
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
      return { packages: packages.map(({ directory }) => directory), entries };
    },
  );
}
