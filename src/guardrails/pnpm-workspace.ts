import { existsSync, readFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";

import { type Document, isMap, isScalar, isSeq, parseDocument } from "yaml";

import { admits } from "../garden/semver.ts";
import type { AgentsBlockContext } from "./agents-block.ts";
import { packageManager, usesCaptures, type Manifest } from "./package.ts";
import { pnpmLockfiles } from "./singleton-packages.ts";
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
 * A folder pnpm installs as its own workspace root, and so the folder whose `pnpm-workspace.yaml` pnpm reads there: the
 * repository root, or a nested folder with its own `pnpm-lock.yaml`, such as `playground`, which never reads the root's file.
 * `builds` are the dependency builds sync decides in it.
 */
interface InstallRoot {
  folder: string;
  builds: string[];
}

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

/**
 * The repository root, deciding the builds of the full profile's hooks and captures, and each folder whose tracked
 * `pnpm-lock.yaml` `lockfile:singletons` reads.
 */
function installRoots(
  root: string,
  profile: AgentsBlockContext["profile"],
): InstallRoot[] {
  const nested = pnpmLockfiles(root)
    .map((lockfile) => dirname(lockfile))
    .filter((folder) => folder !== ".")
    .map((folder) => ({ folder, builds: [] }));
  const builds = profile === "full" ? skippedBuilds(usesCaptures(root)) : [];
  return [{ folder: "", builds }, ...nested];
}

/** Whether `current` holds nothing but the settings sync writes, so pnpm reads it only to make the repository root a workspace. */
function onlySyncedSettings(current: string): boolean {
  const document = parseDocument(current);
  if (document.errors.length || !isMap(document.contents)) return false;
  const synced = skippedBuilds(true);
  return document.contents.items.every(({ key, value }) => {
    if (!isScalar(key)) return false;
    if (key.value === EXCLUDE)
      return (
        isSeq(value) &&
        value.items.every(
          (item) => isScalar(item) && item.value === FRESH_RELEASES,
        )
      );
    return (
      key.value === "allowBuilds" &&
      isMap(value) &&
      value.items.length > 0 &&
      value.items.every(
        (build) =>
          isScalar(build.key) &&
          synced.includes(String(build.key.value)) &&
          isScalar(build.value) &&
          build.value.value === false,
      )
    );
  });
}

/** Sets `allowBuilds.<name>` to `false` for each of `names` the repository does not already decide. Returns whether it changed `document`. */
function decideBuilds(document: Document, names: string[]): boolean {
  if (!names.length) return false;
  if (document.get("allowBuilds") == null)
    document.set("allowBuilds", document.createNode({}));
  const builds = document.get("allowBuilds");
  if (!isMap(builds)) throw new Error("allowBuilds must be a mapping.");
  const undecided = names.filter((name) => builds.get(name) == null);
  if (!undecided.length) return false;
  builds.flow = false;
  for (const name of undecided) builds.set(name, false);
  return true;
}

/** Adds `FRESH_RELEASES` to an existing `minimumReleaseAgeExclude` list unless it holds it. Returns whether it changed `document`. */
function excludeFreshReleases(document: Document): boolean {
  const excluded = document.get(EXCLUDE);
  if (!isSeq(excluded)) throw new Error(`${EXCLUDE} must be a list.`);
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

/** `text` followed by a line break when it lacks one, and by `block`, so a file sync only appends to keeps every other byte, flow-map padding included. */
function appended(text: string, block: string): string {
  return `${text}${text === "" || text.endsWith("\n") ? "" : "\n"}${block}`;
}

/**
 * `current` with `allowBuilds.<name>` set to `false` for each of `names` the repository does not already decide, and
 * `@antelopejs/interface-*` in `minimumReleaseAgeExclude`. pnpm 11 fails an install on a dependency build it was not told
 * about, and locks two copies of an interface released less than a day ago.
 */
function withSyncedSettings(names: string[], current = ""): string {
  const exclude = `${EXCLUDE}:\n  - "${FRESH_RELEASES}"\n`;
  const document = parseDocument(current);
  if (document.errors.length)
    throw new Error(document.errors.map(({ message }) => message).join("; "));
  if (document.toJS() == null) {
    const kept = current.trimStart();
    const lines = names.map((name) => `  ${name}: false\n`).join("");
    const builds = names.length
      ? appended(kept, `allowBuilds:\n${lines}`)
      : kept;
    return appended(builds, exclude);
  }
  if (!isMap(document.contents))
    throw new Error("its top level must be a YAML mapping.");
  const absent = document.get(EXCLUDE) == null;
  const decided = decideBuilds(document, names);
  const excluded = !absent && excludeFreshReleases(document);
  document.contents.flow = false;
  const text =
    decided || excluded
      ? document.toString({ lineWidth: 0, flowCollectionPadding: false })
      : current;
  return absent ? appended(text, exclude) : text;
}

/** Why sync refuses a repository root `pnpm-workspace.yaml` that holds only its own settings under `action`. */
function refusal(action: "skip" | "raise", builds: string[]): string {
  const need = builds.length
    ? `to install ${builds.join(" and ")}`
    : "to lock one copy of an interface released less than a day ago";
  return action === "skip"
    ? `${PATH} holds nothing but the settings antelopejs-sync writes. pnpm before 11 does not need it, and it makes a nested \`pnpm install\` install the repository root. Delete ${PATH}, then rerun antelopejs-sync.`
    : `pnpm 11 needs a ${PATH} ${need}, and before ${SCOPED_NESTED_INSTALLS} that file makes a nested \`pnpm install\` install the repository root. Set \`packageManager\` to \`pnpm@${SCOPED_NESTED_INSTALLS}\` or later, then rerun antelopejs-sync.`;
}

/** The artifact for the `pnpm-workspace.yaml` of one install root; none for a file sync need not create. */
function installRootArtifact(
  root: string,
  manifest: Manifest,
  { folder, builds }: InstallRoot,
): PlannedArtifact[] {
  const path = folder === "" ? PATH : posix.join(folder, PATH);
  const file = join(root, path);
  const current = existsSync(file) ? readFileSync(file, "utf8") : undefined;
  try {
    const content = withSyncedSettings(builds, current);
    const action = creation(manifest);
    if (action === "skip" && current === undefined) return [];
    if (folder === "" && action !== "write" && onlySyncedSettings(content))
      return [{ kind: "error", path, message: refusal(action, builds) }];
    return [
      content === current
        ? { kind: "unchanged", path }
        : { kind: "write", path, content, mode: undefined },
    ];
  } catch (error) {
    const settings = [
      ...(builds.length
        ? [
            `\`allowBuilds: { ${builds.map((name) => `${name}: false`).join(", ")} }\``,
          ]
        : []),
      `\`${EXCLUDE}: ["${FRESH_RELEASES}"]\``,
    ];
    return [
      {
        kind: "error",
        path,
        message: `${path}: ${error instanceof Error ? error.message : String(error)} Add ${settings.join(" and ")} to it, then rerun antelopejs-sync.`,
      },
    ];
  }
}

/**
 * The `pnpm-workspace.yaml` of each folder pnpm installs as its own workspace root in a pnpm repository: the repository root
 * and each nested folder with its own `pnpm-lock.yaml`. Each lists `@antelopejs/interface-*` under `minimumReleaseAgeExclude`,
 * so pnpm 11 and later lock one copy of an interface released less than a day ago. A full-profile root also decides the
 * builds sync declares, so pnpm 11 installs them without `ERR_PNPM_IGNORED_BUILDS`.
 */
export function pnpmWorkspaceArtifacts(
  root: string,
  manifest: Manifest,
  profile: AgentsBlockContext["profile"],
): PlannedArtifact[] {
  if (packageManager(manifest) !== "pnpm") return [];
  return installRoots(root, profile).flatMap((installRoot) =>
    installRootArtifact(root, manifest, installRoot),
  );
}
