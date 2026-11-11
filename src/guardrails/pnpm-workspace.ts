import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { isMap, parseDocument } from "yaml";

import { admits } from "../garden/semver.ts";
import { packageManager, type Manifest } from "./package.ts";
import type { PlannedArtifact } from "./sync.ts";

const PATH = "pnpm-workspace.yaml";

/** Whether the pinned pnpm reads settings from a `pnpm-workspace.yaml` without `packages`, which pnpm before 10.5 rejects. An unpinned pnpm counts as current. */
function readsSettings(manifest: Manifest): boolean {
  const pinned = manifest.packageManager?.split("@")[1];
  return pinned === undefined || admits(">=10.5.0", pinned);
}

/**
 * `current` with `allowBuilds.lefthook` set to `false` unless the repository already decides it.
 * pnpm 11 fails an install on a dependency build it was not told about, and the synced `prepare` script runs `lefthook install` itself.
 */
function withLefthookDecided(current: string | undefined): string {
  const document = parseDocument(current ?? "{}\n");
  if (document.errors.length)
    throw new Error(
      `${PATH}: ${document.errors.map(({ message }) => message).join("; ")}`,
    );
  if (!isMap(document.contents))
    throw new Error(`${PATH} must contain a YAML mapping.`);
  if (current === undefined) document.contents.flow = false;
  if (!document.has("allowBuilds"))
    document.set("allowBuilds", document.createNode({}));
  if (!isMap(document.get("allowBuilds")))
    throw new Error(`${PATH}: allowBuilds must be a mapping.`);
  if (!document.hasIn(["allowBuilds", "lefthook"]))
    document.setIn(["allowBuilds", "lefthook"], false);
  return document.toString({ lineWidth: 0 });
}

/** The `pnpm-workspace.yaml` a full-profile pnpm repository needs so pnpm 11 and later install lefthook without `ERR_PNPM_IGNORED_BUILDS`. */
export function pnpmWorkspaceArtifacts(
  root: string,
  manifest: Manifest,
  managed: boolean,
): PlannedArtifact[] {
  if (!managed || packageManager(manifest) !== "pnpm") return [];
  const file = join(root, PATH);
  const current = existsSync(file) ? readFileSync(file, "utf8") : undefined;
  if (current === undefined && !readsSettings(manifest)) return [];
  try {
    const content = withLefthookDecided(current);
    return [
      content === current
        ? { kind: "unchanged", path: PATH }
        : { kind: "write", path: PATH, content, mode: undefined },
    ];
  } catch (error) {
    return [
      {
        kind: "error",
        path: PATH,
        message: `${error instanceof Error ? error.message : String(error)} Add \`allowBuilds: { lefthook: false }\` to it, then rerun antelopejs-sync.`,
      },
    ];
  }
}
