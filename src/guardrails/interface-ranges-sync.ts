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

/** Relocks with pnpm, whose lockfile a frozen install refuses once a range moved; returns why it could not. */
function relock(root: string, manifests: readonly TrackedManifest[]) {
  const rootManifest = manifests.find(({ path }) => path === "package.json");
  const manager = packageManager(rootManifest?.manifest ?? {});
  return manager === "pnpm"
    ? runPnpm(root, ["install", "--lockfile-only"])
    : `${manager} is not pnpm, so sync did not relock them.`;
}

/**
 * Moves each tracked manifest's range for an interface it implements from
 * this repository to the range `antelopejs-check-interface-ranges` expects,
 * then relocks. A minor release of that interface otherwise leaves its
 * module's range below the new version and fails the check on the release
 * commit. It runs before the rest of sync, which then plans the docs-compat
 * READMEs from the moved ranges and the new lockfile. `check` reports the
 * moves without writing.
 */
export function moveInterfaceRanges(root: string, check: boolean): RangeMoves {
  const manifests = tracked(root);
  const versions = localVersions(manifests.map(({ manifest }) => manifest));
  const moves: RangeMoves = { paths: [], notes: [], errors: [] };
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
    if (!check)
      writeFileSync(join(root, path), serializeManifest(manifest, text));
    moves.paths.push(path);
    moves.notes.push(...fixes.map((fix) => movedNote(path, fix)));
  }
  if (check || !moves.paths.length) return moves;
  const failure = relock(root, manifests);
  if (failure !== undefined)
    moves.errors.push(
      `Moved the interface ranges in ${moves.paths.join(", ")}. Update the lockfile with an install. ${failure}`,
    );
  return moves;
}
