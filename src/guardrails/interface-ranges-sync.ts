import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  checkInterfaceRanges,
  localVersions,
  type RangeViolation,
} from "../interface-ranges.ts";
import { trackedManifests } from "./files.ts";
import {
  packageManager,
  parseManifest,
  serializeManifest,
  type Manifest,
} from "./package.ts";
import { runPnpm } from "./run-pnpm.ts";

/** The manifests whose ranges moved, a note per moved range, and why the lockfile could not follow. */
export interface RangeMoves {
  paths: string[];
  notes: string[];
  errors: string[];
}

interface TrackedManifest {
  path: string;
  text: string;
  manifest: Manifest;
}

/** Each tracked manifest that parses; a fixture that is not JSON is not a package this repository releases. */
function tracked(root: string): TrackedManifest[] {
  return trackedManifests(root).flatMap((path) => {
    try {
      const text = readFileSync(join(root, path), "utf8");
      return [{ path, text, manifest: parseManifest(text) }];
    } catch {
      return [];
    }
  });
}

function movedNote(path: string, violation: RangeViolation): string {
  return `${path}: moved ${violation.field}["${violation.name}"] from "${violation.spec}" to "${violation.expected}", the range of the interface version this repository holds.`;
}

/** The relock failure, after which the moved manifests are back as they were so the next sync moves them again. */
function writeAndRelock(
  root: string,
  manifests: readonly TrackedManifest[],
  moved: ReadonlyMap<string, { before: string; after: string }>,
): string | undefined {
  const rootManifest = manifests.find(({ path }) => path === "package.json");
  const manager = packageManager(rootManifest?.manifest ?? {});
  if (manager !== "pnpm")
    return `${manager} is not pnpm, so sync cannot relock them.`;
  for (const [path, { after }] of moved) writeFileSync(join(root, path), after);
  const failure = runPnpm(root, ["install", "--lockfile-only"]);
  if (failure !== undefined)
    for (const [path, { before }] of moved)
      writeFileSync(join(root, path), before);
  return failure;
}

/**
 * Moves each tracked manifest's range for an interface it implements from
 * this repository to the range `antelopejs-check-interface-ranges` expects,
 * then relocks, or leaves every manifest as it was when the relock fails. A
 * minor release of that interface otherwise leaves its module's range below
 * the new version and fails the check on the release commit. It runs before
 * the rest of sync, which then plans the docs-compat READMEs from the moved
 * ranges and the new lockfile. `check` reports the moves without writing.
 */
export function moveInterfaceRanges(root: string, check: boolean): RangeMoves {
  const manifests = tracked(root);
  const versions = localVersions(manifests.map(({ manifest }) => manifest));
  const moves: RangeMoves = { paths: [], notes: [], errors: [] };
  const moved = new Map<string, { before: string; after: string }>();
  for (const { path, text, manifest } of manifests) {
    const fixes = checkInterfaceRanges(manifest, versions).filter(
      (violation) =>
        violation.role === "implementer" &&
        violation.expected !== undefined &&
        versions.has(violation.name),
    );
    if (!fixes.length) continue;
    for (const { field, name, expected } of fixes) {
      const dependencies = manifest[field];
      if (dependencies && expected) dependencies[name] = expected;
    }
    moved.set(path, { before: text, after: serializeManifest(manifest, text) });
    moves.paths.push(path);
    moves.notes.push(...fixes.map((fix) => movedNote(path, fix)));
  }
  if (check || !moved.size) return moves;
  const failure = writeAndRelock(root, manifests, moved);
  if (failure !== undefined)
    moves.errors.push(
      `Left the interface ranges in ${moves.paths.join(", ")} unmoved: the lockfile could not follow them. ${failure}`,
    );
  return moves;
}
