import { existsSync, readFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";

import { type Document, isMap, isScalar, isSeq, parseDocument } from "yaml";

import { admits } from "../garden/semver.ts";
import type { AgentsBlockContext } from "./agents-block.ts";
import {
  CAPTURE_PEERS,
  DECLARED_PACKAGES,
  packageManager,
  parseManifest,
  usesCaptures,
  type Manifest,
} from "./package.ts";
import { gitFiles } from "./files.ts";
import { pnpmLockfiles } from "./singleton-packages.ts";
import type { PlannedArtifact } from "./sync.ts";
import { installsWithPnpm, inWorkspace } from "./lockfile-reading.ts";

const PATH = "pnpm-workspace.yaml";

/** The folder a repository's playground lives in. */
const PLAYGROUND = "playground";

/** The first pnpm that keeps `pnpm --dir <nested> install` in the nested project when the root `pnpm-workspace.yaml` has no `packages`. Earlier pnpm installs the root instead. */
const SCOPED_NESTED_INSTALLS = "11.27.1";

/** The first pnpm that holds an install to `minimumReleaseAge`: 10.16 reads the setting, and before 10.17.0 it still installs a release published that day. */
const HONOURS_RELEASE_AGE = "10.17.0";

/** The pnpm setting holding the minutes a release must have been published for before pnpm installs it. */
const RELEASE_AGE = "minimumReleaseAge";

/** The lowest `minimumReleaseAge` a repository may set: one day, so a broken release is pulled or fixed before an install locks it. */
const MINIMUM_RELEASE_AGE = 1440;

/** The pnpm setting that lists the packages pnpm installs the day they are published, despite `minimumReleaseAge`. */
const EXCLUDE = "minimumReleaseAgeExclude";

/**
 * The packages sync lists under `minimumReleaseAgeExclude`: AntelopeJS's own, so a repository installs an AntelopeJS release
 * the day it is published. Under the one-day age, pnpm resolves a range that admits an older interface release to that release,
 * and only a range that admits nothing older to the new one, so a fresh install locks two copies of one interface and
 * `lockfile:singletons` fails.
 */
const FRESH_RELEASES = "@antelopejs/*";

/** The narrower pattern sync listed before `FRESH_RELEASES`, which sync replaces with it. */
const INTERFACE_RELEASES = "@antelopejs/interface-*";

/**
 * A folder pnpm installs as its own workspace root, and so the folder whose `pnpm-workspace.yaml` pnpm reads there: the
 * repository root, a nested folder with its own `pnpm-lock.yaml`, or a playground installed on its own; a nested one
 * never reads the root's file.
 * `builds` are the dependency builds sync decides in it.
 */
interface InstallRoot {
  folder: string;
  builds: string[];
}

/**
 * What sync does for a repository by its pinned pnpm. An unpinned pnpm counts as current, and so does the pnpm of a
 * repository whose root pins another package manager.
 * pnpm before 10.17.0 installs a release the day it is published whatever the file says, so its pin must rise (`age`).
 * pnpm 11 before 11.27.1 misroutes nested installs under a root file that holds only synced settings, so its pin must rise then (`nested`).
 */
function creation(manifest: Manifest): "write" | "age" | "nested" {
  const pinned =
    packageManager(manifest) === "pnpm"
      ? manifest.packageManager?.split("@")[1]
      : undefined;
  if (pinned === undefined) return "write";
  if (!admits(`>=${HONOURS_RELEASE_AGE}`, pinned)) return "age";
  return admits(`>=11.0.0 <${SCOPED_NESTED_INSTALLS}`, pinned)
    ? "nested"
    : "write";
}

/** The dependency builds sync declares and pnpm 11 must be told to skip: each `skip` package in `DECLARED_PACKAGES`, and the capture peers only when the repository has captures. */
function skippedBuilds(captures: boolean): string[] {
  const peers: readonly string[] = CAPTURE_PEERS;
  return Object.entries(DECLARED_PACKAGES)
    .filter(
      ([name, { build }]) =>
        build === "skip" && (captures || !peers.includes(name)),
    )
    .map(([name]) => name);
}

/**
 * The root `playground`, when it has a `package.json` and no workspace above lists it: it is installed as a project of its own,
 * so its first lockfile comes from an install that reads only its own `pnpm-workspace.yaml`.
 */
function playgrounds(root: string): string[] {
  return existsSync(join(root, PLAYGROUND, "package.json")) &&
    !inWorkspace(root, PLAYGROUND)
    ? [PLAYGROUND]
    : [];
}

/**
 * Each folder whose tracked `pnpm-lock.yaml` `lockfile:singletons` reads and the playground installed on its own, and in a
 * pnpm repository the root, as `""`. In a repository whose root another package manager installs, only the nested folders
 * pnpm installs. A root that pins no package manager is pnpm's unless it holds another package manager's lockfile.
 */
function installFolders(root: string, manifest: Manifest): string[] {
  const pnpmRoot =
    manifest.packageManager === undefined
      ? installsWithPnpm(root, ".")
      : packageManager(manifest) === "pnpm";
  const locked = pnpmLockfiles(root).map((lockfile) => dirname(lockfile));
  const unlocked = playgrounds(root).filter(
    (folder) => pnpmRoot || installsWithPnpm(root, folder),
  );
  const nested = [...new Set([...locked, ...unlocked])].filter(
    (folder) => folder !== ".",
  );
  return pnpmRoot ? ["", ...nested] : nested;
}

/** Each of `installFolders`, the root deciding the builds of the full profile's hooks and captures. */
function installRoots(
  root: string,
  manifest: Manifest,
  profile: AgentsBlockContext["profile"],
): InstallRoot[] {
  const builds = profile === "full" ? skippedBuilds(usesCaptures(root)) : [];
  return installFolders(root, manifest).map((folder) => ({
    folder,
    builds: folder === "" ? builds : [],
  }));
}

/** Whether `current` holds nothing but the settings sync writes, so pnpm reads it only to make the repository root a workspace. */
function onlySyncedSettings(current: string): boolean {
  const document = parseDocument(current);
  if (document.errors.length || !isMap(document.contents)) return false;
  const synced = skippedBuilds(true);
  return document.contents.items.every(({ key, value }) => {
    if (!isScalar(key)) return false;
    if (key.value === RELEASE_AGE) return true;
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

/** `value` as a whole number of minutes, or `undefined` when it is not one. */
function minutes(value: unknown): number | undefined {
  return Number.isInteger(value) ? Number(value) : undefined;
}

/** Raises `minimumReleaseAge` to `MINIMUM_RELEASE_AGE` when the repository sets no value or a lower one. Returns whether it changed `document`. */
function holdReleaseAge(document: Document): boolean {
  const age = document.get(RELEASE_AGE);
  if (age != null && minutes(age) === undefined)
    throw new Error(`${RELEASE_AGE} must be a number of minutes.`);
  if ((minutes(age) ?? 0) >= MINIMUM_RELEASE_AGE) return false;
  document.set(RELEASE_AGE, MINIMUM_RELEASE_AGE);
  return true;
}

/** Adds `FRESH_RELEASES` to an existing `minimumReleaseAgeExclude` list unless it holds it, in place of `INTERFACE_RELEASES` when the list holds that. Returns whether it changed `document`. */
function excludeFreshReleases(document: Document): boolean {
  const excluded = document.get(EXCLUDE);
  if (!isSeq(excluded)) throw new Error(`${EXCLUDE} must be a list.`);
  const listed = (pattern: string) =>
    excluded.items.find((item) => isScalar(item) && item.value === pattern);
  if (listed(FRESH_RELEASES)) return false;
  const narrower = listed(INTERFACE_RELEASES);
  if (isScalar(narrower)) narrower.value = FRESH_RELEASES;
  else {
    excluded.flow = false;
    excluded.add(FRESH_RELEASES);
  }
  return true;
}

/** `text` followed by a line break when it lacks one, and by each of `blocks`, so a file sync only appends to keeps every other byte, flow-map padding included. */
function appended(text: string, ...blocks: string[]): string {
  return blocks.reduce(
    (done, block) =>
      `${done}${done === "" || done.endsWith("\n") ? "" : "\n"}${block}`,
    text,
  );
}

/**
 * `current` with `allowBuilds.<name>` set to `false` for each of `names` the repository does not already decide,
 * `minimumReleaseAge` at one day or more, and `@antelopejs/*` in `minimumReleaseAgeExclude`. A `nested` file with no `packages`
 * gets `packages: ["."]`, since pnpm 10.33 fails `pnpm --dir <folder>` with "packages field missing or empty" on a nested file
 * that has none. pnpm 11 fails an install on a
 * dependency build it was not told about, pnpm installs a release the day it is published without the age, and with the age
 * but no exclusion locks two copies of an interface released less than a day ago.
 */
function withSyncedSettings(
  names: string[],
  current = "",
  nested = false,
): string {
  const packages = nested ? `packages:\n  - "."\n` : "";
  const age = `${RELEASE_AGE}: ${MINIMUM_RELEASE_AGE}\n`;
  const exclude = `${EXCLUDE}:\n  - "${FRESH_RELEASES}"\n`;
  const document = parseDocument(current);
  if (document.errors.length)
    throw new Error(document.errors.map(({ message }) => message).join("; "));
  if (document.toJS() == null) {
    const lines = names.map((name) => `  ${name}: false\n`).join("");
    const builds = names.length ? [`allowBuilds:\n${lines}`] : [];
    return appended(
      current.trimStart(),
      ...(packages ? [packages] : []),
      ...builds,
      age,
      exclude,
    );
  }
  if (!isMap(document.contents))
    throw new Error("its top level must be a YAML mapping.");
  const ageAbsent = !document.has(RELEASE_AGE);
  const excludeAbsent = document.get(EXCLUDE) == null;
  const packagesAbsent = packages !== "" && !document.has("packages");
  const decided = decideBuilds(document, names);
  const held = !ageAbsent && holdReleaseAge(document);
  const excluded = !excludeAbsent && excludeFreshReleases(document);
  document.contents.flow = false;
  const text =
    decided || held || excluded
      ? document.toString({ lineWidth: 0, flowCollectionPadding: false })
      : current;
  return appended(
    text,
    ...(packagesAbsent ? [packages] : []),
    ...(ageAbsent ? [age] : []),
    ...(excludeAbsent ? [exclude] : []),
  );
}

/** Why sync refuses a repository root `pnpm-workspace.yaml` under `action`: always for `age`, and for `nested` when the file holds only synced settings. */
function refusal(action: "age" | "nested", builds: string[]): string {
  const need = builds.length
    ? `to install ${builds.join(" and ")}`
    : "to lock one copy of an interface released less than a day ago";
  return action === "age"
    ? `pnpm before ${HONOURS_RELEASE_AGE} installs a release the day it is published, whatever ${RELEASE_AGE} says. Set \`packageManager\` to \`pnpm@${HONOURS_RELEASE_AGE}\` or later, then rerun antelopejs-sync.`
    : `pnpm 11 needs a ${PATH} ${need}, and before ${SCOPED_NESTED_INSTALLS} that file makes a nested \`pnpm install\` install the repository root. Set \`packageManager\` to \`pnpm@${SCOPED_NESTED_INSTALLS}\` or later, then rerun antelopejs-sync.`;
}

/** The artifact for the `pnpm-workspace.yaml` of one install root. */
function installRootArtifact(
  root: string,
  manifest: Manifest,
  { folder, builds }: InstallRoot,
): PlannedArtifact[] {
  const path = folder === "" ? PATH : posix.join(folder, PATH);
  const file = join(root, path);
  const current = existsSync(file) ? readFileSync(file, "utf8") : undefined;
  try {
    const content = withSyncedSettings(builds, current, folder !== "");
    const action = creation(manifest);
    if (
      folder === "" &&
      (action === "age" || (action === "nested" && onlySyncedSettings(content)))
    )
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
      `\`${RELEASE_AGE}: ${MINIMUM_RELEASE_AGE}\``,
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

/** Why the `pnpm-workspace.yaml` of the install root `folder` lets pnpm install a release the day it is published, or lets that age hold back an AntelopeJS release; empty when it does neither. */
function releaseAgeFailures(root: string, folder: string): string[] {
  const path = folder === "" ? PATH : posix.join(folder, PATH);
  const file = join(root, path);
  if (!existsSync(file))
    return [
      `${path} is missing, so pnpm installs a release the day it is published.`,
    ];
  const document = parseDocument(readFileSync(file, "utf8"));
  if (document.errors.length)
    return [`${path}: ${document.errors[0]?.message ?? "invalid YAML"}`];
  const settings = isMap(document.contents) ? document.contents : undefined;
  const age = settings?.get(RELEASE_AGE);
  const excluded = settings?.get(EXCLUDE);
  const ageFailure =
    age == null
      ? `${path} does not set ${RELEASE_AGE}, so pnpm installs a release the day it is published.`
      : `${path} sets ${RELEASE_AGE} to ${JSON.stringify(age)}, not a number of minutes of at least ${MINIMUM_RELEASE_AGE} (one day), so pnpm installs a release published less than a day ago.`;
  return [
    ...((minutes(age) ?? 0) >= MINIMUM_RELEASE_AGE ? [] : [ageFailure]),
    ...(isSeq(excluded) &&
    excluded.items.some(
      (item) => isScalar(item) && item.value === FRESH_RELEASES,
    )
      ? []
      : [
          `${path} does not list "${FRESH_RELEASES}" under ${EXCLUDE}, so an install waits a day for an AntelopeJS release.`,
        ]),
  ];
}

/** The folders, `""` for the root, whose `pnpm-workspace.yaml` `pnpm:release-age` reads: each folder pnpm installs as its own workspace root. */
export function releaseAgeFolders(root: string): string[] {
  return installFolders(
    root,
    parseManifest(readFileSync(join(root, "package.json"), "utf8")),
  );
}

/** A `package.json` failure of `pnpm:release-age`; `sync` is whether `antelopejs-sync` repairs it. */
interface PinFailure {
  message: string;
  sync: boolean;
}

/** The root's pnpm pin when it honours `minimumReleaseAge`, which a nested `package.json` is told to copy. */
function rootPin(root: string): string | undefined {
  try {
    const pin = parseManifest(
      readFileSync(join(root, "package.json"), "utf8"),
    ).packageManager;
    const [manager, version] = pin?.split("@") ?? [];
    return manager === "pnpm" &&
      version !== undefined &&
      admits(`>=${HONOURS_RELEASE_AGE}`, version)
      ? pin
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Each `package.json` of the repository outside `node_modules` that is not valid JSON, or that pins `packageManager` to a pnpm
 * before `HONOURS_RELEASE_AGE`, which ignores `minimumReleaseAge` whatever the workspace file says. Sync raises the root's
 * pin and leaves a nested one alone, so a nested failure says to copy the root's pin.
 */
function packageJsonFailures(root: string): PinFailure[] {
  return gitFiles(root)
    .filter(
      (file) =>
        (file === "package.json" || file.endsWith("/package.json")) &&
        !file.split("/").includes("node_modules") &&
        existsSync(join(root, file)),
    )
    .sort()
    .flatMap((file): PinFailure[] => {
      let pin: string | undefined;
      try {
        pin = parseManifest(
          readFileSync(join(root, file), "utf8"),
        ).packageManager;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return [
          {
            message: `${file} is not valid JSON, so its packageManager pin cannot be read: ${reason}`,
            sync: false,
          },
        ];
      }
      const [manager, version] = pin?.split("@") ?? [];
      if (
        manager !== "pnpm" ||
        version === undefined ||
        admits(`>=${HONOURS_RELEASE_AGE}`, version)
      )
        return [];
      const failure = `${file} pins packageManager to ${pin}, and pnpm before ${HONOURS_RELEASE_AGE} installs a release the day it is published, whatever ${RELEASE_AGE} says.`;
      if (file === "package.json") return [{ message: failure, sync: true }];
      const target = rootPin(root) ?? `pnpm@${HONOURS_RELEASE_AGE} or later`;
      return [
        {
          message: `${failure} Set packageManager in ${file} to ${target}.`,
          sync: false,
        },
      ];
    });
}

/**
 * The `pnpm:release-age` failure: each install root whose `pnpm-workspace.yaml` is missing, sets `minimumReleaseAge` below
 * 1440 or not at all, or does not list `@antelopejs/*` under `minimumReleaseAgeExclude`, and each `package.json` that pins a
 * pnpm before 10.17.0; empty when every one passes.
 */
export function checkReleaseAge(root: string): string {
  const folders = releaseAgeFolders(root).flatMap((folder) =>
    releaseAgeFailures(root, folder),
  );
  const pins = packageJsonFailures(root);
  const failures = [...folders, ...pins.map((pin) => pin.message)];
  if (failures.length === 0) return "";
  const sync = folders.length > 0 || pins.some((pin) => pin.sync);
  return `${failures.join("\n")}\n${sync ? "Run antelopejs-sync.\n" : ""}`;
}

/**
 * The `pnpm-workspace.yaml` of each folder pnpm installs as its own workspace root: the root of a pnpm repository and each
 * nested folder with its own `pnpm-lock.yaml` or that is installed with pnpm on its own. Each sets `minimumReleaseAge` to
 * one day or more, so pnpm installs no release published less than a day ago, and lists `@antelopejs/*` under
 * `minimumReleaseAgeExclude`, so AntelopeJS's own releases install the day they are published. Each nested folder holds its
 * own file, so pnpm 10 keeps a nested install in that folder. A full-profile root also decides the builds sync declares, so
 * pnpm 11 installs them without `ERR_PNPM_IGNORED_BUILDS`.
 */
export function pnpmWorkspaceArtifacts(
  root: string,
  manifest: Manifest,
  profile: AgentsBlockContext["profile"],
): PlannedArtifact[] {
  return installRoots(root, manifest, profile).flatMap((installRoot) =>
    installRootArtifact(root, manifest, installRoot),
  );
}
