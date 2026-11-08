import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isMap, parseAllDocuments, type YAMLMap } from "yaml";

import { gitFiles } from "./files.ts";
import {
  DIRECT_FIELDS,
  type Mapping,
  Unreadable,
  keys,
  mapping,
  scalar,
} from "./verify-lockfiles.ts";

const PNPM_LOCK = "pnpm-lock.yaml";

/** Packages one process must load once: every AntelopeJS interface package shares one runtime with its peers. */
const SINGLETON = /^@antelopejs\/interface-/u;

/** The fields of a lockfile package entry that point at the copy each dependency resolves to. */
const PACKAGE_FIELDS = ["dependencies", "optionalDependencies"] as const;

/** How to move every importer onto one copy while pnpm keeps every other locked version, which `pnpm dedupe` does not. */
const REPAIR =
  "  Set the direct specifier that locks the older copy to the newer version, run `pnpm install --lockfile-only`, then restore the specifier.\n";

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
  const target = packageKey(version) ?? {
    name,
    version: withoutPeers(version),
  };
  copies.get(target.name)?.get(target.version)?.add(by);
}

function addPullers(
  copies: Copies,
  node: Mapping,
  fields: readonly string[],
  by: string,
): void {
  for (const field of fields) {
    const entries = mapping(node, field);
    for (const name of keys(entries))
      pull(
        copies,
        name,
        scalar(entries, name) ?? scalar(mapping(entries, name), "version"),
        by,
      );
  }
}

/** Each document of a lockfile: pnpm 11 writes its config dependencies, installed apart from the project, as a document before the project's. */
function lockfileDocuments(path: string): YAMLMap[] {
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

function documentCopies(lockfile: YAMLMap): Copies {
  const copies: Copies = new Map();
  const packages = mapping(lockfile, "packages");
  for (const parsed of keys(packages).map(packageKey))
    if (parsed && SINGLETON.test(parsed.name))
      copies.set(
        parsed.name,
        (copies.get(parsed.name) ?? new Map()).set(parsed.version, new Set()),
      );
  const importers = mapping(lockfile, "importers");
  for (const importer of importers ? keys(importers) : ["."])
    addPullers(
      copies,
      importers ? mapping(importers, importer) : lockfile,
      DIRECT_FIELDS,
      `importer "${importer}"`,
    );
  const resolved = mapping(lockfile, "snapshots") ?? packages;
  for (const key of keys(resolved))
    addPullers(
      copies,
      mapping(resolved, key),
      PACKAGE_FIELDS,
      withoutPeers(key.replace(/^\//u, "")),
    );
  return copies;
}

function report(file: string, copies: Copies): string {
  return [...copies]
    .filter(([, versions]) => versions.size > 1)
    .map(
      ([name, versions]) =>
        `${file} resolves "${name}" at ${versions.size} versions, and an interface package must load once:\n${[
          ...versions,
        ]
          .map(
            ([version, by]) =>
              `  ${version}, pulled by ${[...by].join(", ") || "nothing"}\n`,
          )
          .join("")}${REPAIR}`,
    )
    .join("");
}

/** The `pnpm-lock.yaml` files on disk in the repository, tracked or not yet added, outside what `.gitignore` leaves out. */
export function pnpmLockfiles(root: string): string[] {
  return gitFiles(root).filter(
    (file) =>
      (file === PNPM_LOCK || file.endsWith(`/${PNPM_LOCK}`)) &&
      existsSync(join(root, file)),
  );
}

/**
 * Fails when a `pnpm-lock.yaml` of the repository resolves an AntelopeJS interface package, any `@antelopejs/interface-*`,
 * at more than one version: each copy carries its own runtime, so two copies in one process break the contract between
 * modules, or throw on a runtime protocol mismatch. Names, for each version, the importers and packages that pull it.
 * Reads the lockfiles only: it spawns no package manager, writes no file and fetches nothing. Returns what failed, empty
 * when every interface package resolves once.
 */
export function checkSingletonPackages(root: string): string {
  return pnpmLockfiles(root)
    .map((file) => {
      try {
        return lockfileDocuments(join(root, file))
          .map((document) => report(file, documentCopies(document)))
          .join("");
      } catch (error) {
        if (error instanceof Unreadable)
          return `${file}: could not read it as a lockfile version this check knows.\n`;
        throw error;
      }
    })
    .join("");
}
