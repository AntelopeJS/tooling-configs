import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { type Document, isMap, isScalar, isSeq, parseDocument } from "yaml";

import { admits } from "../garden/semver.ts";
import { packageManager, usesCaptures, type Manifest } from "./package.ts";
import type { PlannedArtifact } from "./sync.ts";

const PATH = "pnpm-workspace.yaml";

/** The first pnpm that keeps `pnpm --dir <nested> install` in the nested project when the root `pnpm-workspace.yaml` has no `packages`. Earlier pnpm installs the root instead. */
const SCOPED_NESTED_INSTALLS = "11.27.1";

/** The pnpm setting that lists the packages pnpm 11 installs the day they are published, despite its one-day `minimumReleaseAge` default. */
const EXCLUDE = "minimumReleaseAgeExclude";

/**
 * The packages sync lists under `minimumReleaseAgeExclude`. Under the one-day default, pnpm 11 resolves a range that admits
 * an older interface release to that release, and only a range that admits nothing older to the new one, so a fresh install
 * locks two copies of one interface and `lockfile:singletons` fails.
 */
const FRESH_RELEASES = "@antelopejs/interface-*";

/**
 * What sync does for a repository without a `pnpm-workspace.yaml`, by its pinned pnpm. An unpinned pnpm counts as current.
 * pnpm 10 and earlier only warn about an undecided build, so they get no file. pnpm 11 fails the install without one, and before 11.27.1 misroutes nested installs with one, so its pin must rise.
 */
function creation(manifest: Manifest): "write" | "skip" | "raise" {
  const pinned = manifest.packageManager?.split("@")[1];
  if (pinned === undefined || admits(`>=${SCOPED_NESTED_INSTALLS}`, pinned))
    return "write";
  return admits(">=11.0.0", pinned) ? "raise" : "skip";
}

/**
 * The dependency builds sync declares and pnpm 11 must be told to skip.
 * The synced `prepare` script runs `lefthook install` itself, and `MongoMemoryServer.create()` downloads the mongod that the capture peer's postinstall would fetch.
 */
function skippedBuilds(captures: boolean): string[] {
  return captures ? ["lefthook", "mongodb-memory-server"] : ["lefthook"];
}

/** Whether `current` holds nothing but the settings sync writes, so pnpm reads it only to make the repository root a workspace. */
function onlySyncedSettings(current: string): boolean {
  const document = parseDocument(current);
  const builds = document.get("allowBuilds");
  const excluded = document.get(EXCLUDE);
  if (
    document.errors.length ||
    !isMap(document.contents) ||
    document.contents.items.length !== 2 ||
    !isMap(builds) ||
    !builds.items.length ||
    !isSeq(excluded)
  )
    return false;
  const synced = skippedBuilds(true);
  return (
    builds.items.every(
      ({ key, value }) =>
        isScalar(key) &&
        synced.includes(String(key.value)) &&
        isScalar(value) &&
        value.value === false,
    ) &&
    excluded.items.every(
      (item) => isScalar(item) && item.value === FRESH_RELEASES,
    )
  );
}

/** Sets `allowBuilds.<name>` to `false` for each of `names` the repository does not already decide. Returns whether it changed `document`. */
function decideBuilds(document: Document, names: string[]): boolean {
  if (document.get("allowBuilds") == null)
    document.set("allowBuilds", document.createNode({}));
  const builds = document.get("allowBuilds");
  if (!isMap(builds))
    throw new Error(`${PATH}: allowBuilds must be a mapping.`);
  const undecided = names.filter((name) => builds.get(name) == null);
  if (!undecided.length) return false;
  builds.flow = false;
  for (const name of undecided) builds.set(name, false);
  return true;
}

/** Adds `FRESH_RELEASES` to `minimumReleaseAgeExclude` unless the list holds it. Returns whether it changed `document`. */
function excludeFreshReleases(document: Document): boolean {
  const excluded = document.get(EXCLUDE);
  if (excluded == null) {
    document.set(EXCLUDE, document.createNode([FRESH_RELEASES]));
    return true;
  }
  if (!isSeq(excluded)) throw new Error(`${PATH}: ${EXCLUDE} must be a list.`);
  if (
    excluded.items.some(
      (item) => isScalar(item) && item.value === FRESH_RELEASES,
    )
  )
    return false;
  excluded.flow = false;
  excluded.add(FRESH_RELEASES);
  return true;
}

/**
 * `current` with `allowBuilds.<name>` set to `false` for each of `names` the repository does not already decide, and
 * `@antelopejs/interface-*` in `minimumReleaseAgeExclude`. pnpm 11 fails an install on a dependency build it was not told
 * about, and locks two copies of an interface released less than a day ago.
 */
function withSyncedSettings(names: string[], current = ""): string {
  const document = parseDocument(current);
  if (document.errors.length)
    throw new Error(
      `${PATH}: ${document.errors.map(({ message }) => message).join("; ")}`,
    );
  if (document.toJS() == null) {
    const kept = current.trimStart();
    const lines = names.map((name) => `  ${name}: false\n`).join("");
    return `${kept}${kept === "" || kept.endsWith("\n") ? "" : "\n"}allowBuilds:\n${lines}${EXCLUDE}:\n  - "${FRESH_RELEASES}"\n`;
  }
  if (!isMap(document.contents))
    throw new Error(`${PATH} must contain a YAML mapping.`);
  const decided = decideBuilds(document, names);
  const excluded = excludeFreshReleases(document);
  if (!decided && !excluded) return current;
  document.contents.flow = false;
  return document.toString({ lineWidth: 0, flowCollectionPadding: false });
}

/** The `pnpm-workspace.yaml` a full-profile pnpm repository needs so pnpm 11 and later install the builds sync declares without `ERR_PNPM_IGNORED_BUILDS`, and lock one copy of an interface released less than a day ago. */
export function pnpmWorkspaceArtifacts(
  root: string,
  manifest: Manifest,
  managed: boolean,
): PlannedArtifact[] {
  if (!managed || packageManager(manifest) !== "pnpm") return [];
  const file = join(root, PATH);
  const current = existsSync(file) ? readFileSync(file, "utf8") : undefined;
  const names = skippedBuilds(usesCaptures(root));
  try {
    const content = withSyncedSettings(names, current);
    const action = creation(manifest);
    if (action !== "write" && onlySyncedSettings(content)) {
      if (action === "skip" && current === undefined) return [];
      return [
        {
          kind: "error",
          path: PATH,
          message:
            action === "skip"
              ? `${PATH} holds nothing but the settings antelopejs-sync writes. pnpm before 11 does not need it, and it makes a nested \`pnpm install\` install the repository root. Delete ${PATH}, then rerun antelopejs-sync.`
              : `pnpm 11 needs a ${PATH} to install ${names.join(" and ")}, and before ${SCOPED_NESTED_INSTALLS} that file makes a nested \`pnpm install\` install the repository root. Set \`packageManager\` to \`pnpm@${SCOPED_NESTED_INSTALLS}\` or later, then rerun antelopejs-sync.`,
        },
      ];
    }
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
        message: `${error instanceof Error ? error.message : String(error)} Add \`allowBuilds: { ${names.map((name) => `${name}: false`).join(", ")} }\` and \`${EXCLUDE}: ["${FRESH_RELEASES}"]\` to it, then rerun antelopejs-sync.`,
      },
    ];
  }
}
