import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { major, minor, prerelease, valid } from "semver";
import { isMap, parseAllDocuments, type YAMLMap } from "yaml";

import { isPreview } from "./dependency-ranges.ts";
import { gitFiles } from "./files.ts";
import {
  type Mapping,
  Unreadable,
  keys,
  mapping,
  readMapping,
  scalar,
} from "./lockfile-reading.ts";

const PNPM_LOCK = "pnpm-lock.yaml";

/** Packages one process must load once: every AntelopeJS interface package shares one runtime with its peers. */
const SINGLETON = /^@antelopejs\/interface-/u;

/** The fields of an importer or a lockfile package entry whose copies a production install reaches; pnpm records a resolved peer under `dependencies`. */
const RUNTIME_FIELDS = ["dependencies", "optionalDependencies"] as const;

/** The fields of an importer whose copies only development installs reach. */
const DEV_FIELDS = ["devDependencies"] as const;

/** A dependency's name and the version or `name@version` reference its lockfile entry resolves it to. */
type Edge = readonly [name: string, version: string];

/** How to move every importer onto one copy while pnpm keeps every other locked version, which `pnpm dedupe` does not. */
const REPAIR =
  "  Set the direct specifier that locks the older copy to the newer version, run `pnpm install --lockfile-only`, then restore the specifier.\n";

/** How a puller that is a manifest of the repository, not a locked package, is named. */
const IMPORTER = "importer ";

/** For each singleton package name, each version its lockfile resolves, with the importers and packages that pull it. */
type Copies = Map<string, Map<string, Set<string>>>;

/** A `name@version` key or a resolved version without its peer suffix, `(peer@1)`, which names no other copy. */
function withoutPeers(reference: string): string {
  const open = reference.indexOf("(");
  return open === -1 ? reference : reference.slice(0, open);
}

/** The name and version of a `packages` key: `@scope/name@1.0.0` in version 9, `/@scope/name@1.0.0` in version 6. */
function packageKey(
  key: string,
): { name: string; version: string } | undefined {
  const match = /^\/?((?:@[^/@]+\/)?[^@]+)@(.+)$/u.exec(withoutPeers(key));
  return match?.[1] && match[2]
    ? { name: match[1], version: match[2] }
    : undefined;
}

/** Records `by` as a puller of the copy a dependency resolves to: `version`, or the `name@version` an `npm:` alias resolves to. */
function pull(
  copies: Copies,
  name: string,
  version: string | undefined,
  by: string,
): void {
  if (version === undefined) return;
  const alias = packageKey(version);
  const target =
    alias && copies.has(alias.name)
      ? alias
      : { name, version: withoutPeers(version) };
  copies.get(target.name)?.get(target.version)?.add(by);
}

/** The dependencies `fields` of an importer or a lockfile package entry list. */
function edges(node: Mapping, fields: readonly string[]): Edge[] {
  return fields.flatMap((field) => {
    const entries = mapping(node, field);
    return keys(entries).flatMap((name): Edge[] => {
      const version =
        scalar(entries, name) ?? scalar(mapping(entries, name), "version");
      return version === undefined ? [] : [[name, version]];
    });
  });
}

/** A lockfile entry key without the leading `/` of version 6. */
const entryKey = (key: string): string => key.replace(/^\//u, "");

/** The `name@version`, without peers, of each entry of `resolved` that a walk from `from` through runtime dependencies reaches. */
function reached(resolved: Mapping, from: readonly Edge[]): Set<string> {
  const entries = new Map(keys(resolved).map((key) => [entryKey(key), key]));
  const seen = new Set<string>();
  const queue = [...from];
  for (const [name, version] of queue) {
    const direct = `${name}@${version}`;
    const key = entries.has(direct) ? direct : entryKey(version);
    const original = entries.get(key);
    if (original === undefined || seen.has(key)) continue;
    seen.add(key);
    queue.push(...edges(mapping(resolved, original), RUNTIME_FIELDS));
  }
  return new Set([...seen].map(withoutPeers));
}

/** Each document of a lockfile: pnpm 11 writes its config dependencies, installed apart from the project, as a document before the project's. */
export function lockfileDocuments(path: string): YAMLMap[] {
  return parseAllDocuments(readFileSync(path, "utf8"), {
    schema: "failsafe",
    uniqueKeys: false,
  }).map((document) => {
    const { contents } = document;
    if (
      document.errors.length > 0 ||
      !isMap(contents) ||
      !(Number.parseFloat(scalar(contents, "lockfileVersion") ?? "") >= 6)
    )
      throw new Unreadable(path);
    return contents;
  });
}

/**
 * Whether the manifest in `folder` lists `name` under `peerDependencies`: the host loads that dependency at runtime, though
 * pnpm locks a peer the manifest also lists under `devDependencies` as a dev dependency only. Every name when the manifest
 * cannot be read, so no copy it might reach is dropped.
 */
function peerOf(folder: string): (name: string) => boolean {
  const path = join(folder, "package.json");
  if (!existsSync(path)) return () => false;
  try {
    const peers = new Set(keys(mapping(readMapping(path), "peerDependencies")));
    return (name) => peers.has(name);
  } catch (error) {
    if (error instanceof Unreadable) return () => true;
    throw error;
  }
}

/**
 * The singleton copies of the lockfile document in `folder`, with their pullers. A copy that devDependencies reach and
 * runtime dependencies do not never ships, so it and the packages that pull it do not count; a copy no importer reaches
 * still does.
 */
function documentCopies(lockfile: YAMLMap, folder: string): Copies {
  const packages = mapping(lockfile, "packages");
  const resolved = mapping(lockfile, "snapshots") ?? packages;
  const importers = mapping(lockfile, "importers");
  const roots = (importers ? keys(importers) : ["."]).map((importer) => {
    const node = importers ? mapping(importers, importer) : lockfile;
    const peer = peerOf(join(folder, importer));
    const dev = edges(node, DEV_FIELDS);
    return {
      by: `${IMPORTER}"${importer}"`,
      node,
      runtime: [
        ...edges(node, RUNTIME_FIELDS),
        ...dev.filter(([name]) => peer(name)),
      ],
      dev: dev.filter(([name]) => !peer(name)),
    };
  });
  const runtime = reached(
    resolved,
    roots.flatMap((root) => root.runtime),
  );
  const dev = reached(
    resolved,
    roots.flatMap((root) => root.dev),
  );
  const devOnly = (entry: string): boolean =>
    !runtime.has(entry) && dev.has(entry);
  const copies: Copies = new Map();
  for (const parsed of keys(packages).map(packageKey))
    if (
      parsed &&
      SINGLETON.test(parsed.name) &&
      !devOnly(`${parsed.name}@${parsed.version}`)
    )
      copies.set(
        parsed.name,
        (copies.get(parsed.name) ?? new Map()).set(parsed.version, new Set()),
      );
  for (const { by, node } of roots)
    for (const [name, version] of edges(node, [
      ...RUNTIME_FIELDS,
      ...DEV_FIELDS,
    ]))
      pull(copies, name, version, by);
  for (const key of keys(resolved)) {
    const by = withoutPeers(entryKey(key));
    if (!devOnly(by))
      for (const [name, version] of edges(
        mapping(resolved, key),
        RUNTIME_FIELDS,
      ))
        pull(copies, name, version, by);
  }
  return copies;
}

/** Whether `other` is a release, not a prerelease, on the minor of `version`. */
const releaseOnMinor = (version: string, other: string): boolean =>
  valid(other) !== null &&
  prerelease(other) === null &&
  major(version) === major(other) &&
  minor(version) === minor(other);

const pulledByImporter = (by: ReadonlySet<string>): boolean =>
  [...by].some((puller) => puller.startsWith(IMPORTER));

/**
 * Whether the copy at `version` is a preview a manifest of the repository pins beside only releases on its minor that
 * locked packages pull, never a manifest: the repository tests that preview ahead of its release, which the packages
 * locking the older copy then admit.
 */
function pinnedPreview(
  version: string,
  by: ReadonlySet<string>,
  versions: ReadonlyMap<string, ReadonlySet<string>>,
): boolean {
  return (
    isPreview(version) &&
    pulledByImporter(by) &&
    [...versions].every(
      ([other, pullers]) =>
        other === version ||
        (releaseOnMinor(version, other) && !pulledByImporter(pullers)),
    )
  );
}

function report(file: string, copies: Copies): string {
  return [...copies]
    .map(([name, versions]) => ({
      name,
      counted: [...versions].filter(
        ([version, by]) => !pinnedPreview(version, by, versions),
      ),
    }))
    .filter(({ counted }) => counted.length > 1)
    .map(
      ({ name, counted }) =>
        `${file} resolves "${name}" at ${counted.length} versions, and an interface package must load once:\n${counted
          .map(
            ([version, by]) =>
              `  ${version}, pulled by ${[...by].join(", ") || "nothing"}\n`,
          )
          .join("")}${REPAIR}`,
    )
    .join("");
}

/** The folder holding a project's module locks, whose dev-only copies no production install reaches. */
const MODULE_LOCKS = "antelope-lock";

/** The `pnpm-lock.yaml` files on disk in the repository, tracked or not yet added, outside what `.gitignore` leaves out and outside `antelope-lock/`. */
export function pnpmLockfiles(root: string): string[] {
  return gitFiles(root).filter(
    (file) =>
      (file === PNPM_LOCK || file.endsWith(`/${PNPM_LOCK}`)) &&
      !file.split("/").includes(MODULE_LOCKS) &&
      existsSync(join(root, file)),
  );
}

/**
 * Fails when a `pnpm-lock.yaml` of the repository resolves an AntelopeJS interface package, any `@antelopejs/interface-*`,
 * at more than one version: each copy carries its own runtime, so two copies in one process break the contract between
 * modules, or throw on a runtime protocol mismatch. A copy only devDependencies reach does not count, though a
 * devDependency the manifest also lists under `peerDependencies` reaches its copies at runtime; nor does a preview a
 * manifest of the repository pins beside only releases on its minor. Names, for each version, the importers that pull it
 * and the packages that pull it through runtime dependencies.
 * Reads the lockfiles and the manifests beside them only: it spawns no package manager, writes no file and fetches
 * nothing. Returns what failed, empty
 * when every interface package resolves once.
 */
export function checkSingletonPackages(root: string): string {
  return pnpmLockfiles(root)
    .map((file) => {
      try {
        return lockfileDocuments(join(root, file))
          .map((document) =>
            report(file, documentCopies(document, join(root, dirname(file)))),
          )
          .join("");
      } catch (error) {
        if (error instanceof Unreadable)
          return `${file}: could not read it as a lockfile version this check knows.\n`;
        throw error;
      }
    })
    .join("");
}
