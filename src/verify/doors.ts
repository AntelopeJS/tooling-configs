import { readFileSync } from "node:fs";
import { matchesGlob } from "node:path";

import type { VerifyKind } from "./kinds.ts";
import type { DoorKind } from "./types.ts";
import type { Workspace } from "./workspace.ts";

/** The door kinds whose path rules a set of changed files hits, with the files per kind. */
export interface FlaggedDoor {
  kind: DoorKind;
  files: string[];
}

const RELEASE_FILES = [
  "package.json",
  ".release-it.json",
  "changelogen.config.json",
  ".github/workflows/release.yml",
];

/** Door globs per kind, for the kinds a repository kind defaults. */
type DoorDefaults = {
  [Kind in VerifyKind]: { [Door in DoorKind]?: string[] };
};

/** The pack's default path rules per repository kind; a repo's `doors` block adds to them. */
const DEFAULT_DOOR_GLOBS: DoorDefaults = {
  interface: { contract: ["src/**", "package.json"], publish: RELEASE_FILES },
  module: { contract: ["package.json"], publish: RELEASE_FILES },
  template: {},
};

/** Every path rule of a door kind: the kind's defaults, the repo's globs and its declared funnels. */
function doorGlobs(workspace: Workspace, kind: DoorKind): string[] {
  const rule = workspace.config.doors[kind];
  if (!rule) return [];
  return [
    ...new Set([
      ...(DEFAULT_DOOR_GLOBS[workspace.kind][kind] ?? []),
      ...rule.globs,
      ...rule.funnels,
    ]),
  ];
}

/** The door kinds whose path rules `files` hit. */
export function flaggedDoors(
  workspace: Workspace,
  files: string[],
): FlaggedDoor[] {
  const kinds: DoorKind[] = [
    "data",
    "format",
    "contract",
    "outbound",
    "exposure",
    "publish",
  ];
  return kinds.flatMap((kind) => {
    const globs = doorGlobs(workspace, kind);
    const hits = files.filter((file) =>
      globs.some((glob) => matchesGlob(file, glob)),
    );
    return hits.length > 0 ? [{ kind, files: hits }] : [];
  });
}

/** The files a unified diff changes, read from its `+++ b/` headers. */
export function patchFiles(patch: string): string[] {
  return [...readFileSync(patch, "utf8").matchAll(/^\+\+\+ b\/(.+)$/gm)].map(
    (match) => match[1],
  );
}

/** The `One-way-door:` line for flagged kinds, or nothing when none is flagged. */
export function doorLine(doors: FlaggedDoor[]): string {
  return doors.length > 0
    ? `One-way-door: ${doors.map((door) => door.kind).join(", ")}`
    : "";
}
