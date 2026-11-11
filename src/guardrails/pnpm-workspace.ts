import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { isMap, parseDocument } from "yaml";

import { admits } from "../garden/semver.ts";
import { packageManager, usesCaptures, type Manifest } from "./package.ts";
import type { PlannedArtifact } from "./sync.ts";

const PATH = "pnpm-workspace.yaml";

/** Whether the pinned pnpm reads settings from a `pnpm-workspace.yaml` without `packages`, which pnpm before 10.5 rejects. An unpinned pnpm counts as current. */
function readsSettings(manifest: Manifest): boolean {
  const pinned = manifest.packageManager?.split("@")[1];
  return pinned === undefined || admits(">=10.5.0", pinned);
}

/**
 * The dependency builds sync declares and pnpm 11 must be told to skip.
 * The synced `prepare` script runs `lefthook install` itself, and `MongoMemoryServer.create()` downloads the mongod that the capture peer's postinstall would fetch.
 */
function skippedBuilds(captures: boolean): string[] {
  return captures ? ["lefthook", "mongodb-memory-server"] : ["lefthook"];
}

/**
 * `current` with `allowBuilds.<name>` set to `false` for each of `names` the repository does not already decide.
 * pnpm 11 fails an install on a dependency build it was not told about.
 */
function withBuildsDecided(names: string[], current = ""): string {
  const document = parseDocument(current);
  if (document.errors.length)
    throw new Error(
      `${PATH}: ${document.errors.map(({ message }) => message).join("; ")}`,
    );
  if (document.toJS() == null) {
    const kept = current.trimStart();
    const lines = names.map((name) => `  ${name}: false\n`).join("");
    return `${kept}${kept === "" || kept.endsWith("\n") ? "" : "\n"}allowBuilds:\n${lines}`;
  }
  if (!isMap(document.contents))
    throw new Error(`${PATH} must contain a YAML mapping.`);
  if (document.get("allowBuilds") == null)
    document.set("allowBuilds", document.createNode({}));
  const builds = document.get("allowBuilds");
  if (!isMap(builds))
    throw new Error(`${PATH}: allowBuilds must be a mapping.`);
  const undecided = names.filter((name) => builds.get(name) == null);
  if (!undecided.length) return current;
  document.contents.flow = false;
  builds.flow = false;
  for (const name of undecided) builds.set(name, false);
  return document.toString({ lineWidth: 0, flowCollectionPadding: false });
}

/** The `pnpm-workspace.yaml` a full-profile pnpm repository needs so pnpm 11 and later install the builds sync declares without `ERR_PNPM_IGNORED_BUILDS`. */
export function pnpmWorkspaceArtifacts(
  root: string,
  manifest: Manifest,
  managed: boolean,
): PlannedArtifact[] {
  if (!managed || packageManager(manifest) !== "pnpm") return [];
  const file = join(root, PATH);
  const current = existsSync(file) ? readFileSync(file, "utf8") : undefined;
  if (current === undefined && !readsSettings(manifest)) return [];
  const names = skippedBuilds(usesCaptures(root));
  try {
    const content = withBuildsDecided(names, current);
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
        message: `${error instanceof Error ? error.message : String(error)} Add \`allowBuilds: { ${names.map((name) => `${name}: false`).join(", ")} }\` to it, then rerun antelopejs-sync.`,
      },
    ];
  }
}
