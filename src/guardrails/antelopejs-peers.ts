import { join } from "node:path";
import type { YAMLMap } from "yaml";

import { Unreadable, keys, mapping, scalar } from "./lockfile-reading.ts";
import { admits, documentLockedVersions } from "./module-peers.ts";
import { lockfileDocuments, pnpmLockfiles } from "./singleton-packages.ts";

const ANTELOPEJS = /^@antelopejs\//u;

/** Where a failure is named: the lockfile, and the importer when it is not the root one. */
const where = (file: string, importer: string): string =>
  importer === "." ? file : `${file} importer "${importer}"`;

/** The failures of one importer of a lockfile document: each peer an `@antelopejs/*` package it locks declares, locked by that importer outside the declared range. */
function importerReport(
  file: string,
  document: YAMLMap,
  importer: string,
): string {
  const locked = documentLockedVersions(document, importer);
  const packages = mapping(document, "packages");
  return [...locked]
    .filter(([name]) => ANTELOPEJS.test(name))
    .flatMap(([name, version]) => {
      const peers = mapping(
        mapping(packages, `${name}@${version}`) ??
          mapping(packages, `/${name}@${version}`),
        "peerDependencies",
      );
      return keys(peers).flatMap((peer) => {
        const range = scalar(peers, peer);
        const at = locked.get(peer);
        return range === undefined ||
          at === undefined ||
          admits(range, at, false)
          ? []
          : [
              `${where(file, importer)} locks "${peer}" at ${at}, outside "${range}", the range ${name}@${version} declares in peerDependencies. Keep ${peer} at a version in that range, or move ${name} to a release that lists ${at}.\n`,
            ];
      });
    })
    .join("");
}

/**
 * Fails when a `pnpm-lock.yaml` of the repository locks, in one importer, a peer of an `@antelopejs/*` package that
 * importer locks outside the range the package's lockfile entry records under `peerDependencies`: pnpm installs it with
 * a warning, and npm refuses the same tree with ERESOLVE. Ranges are read as `lockfile:module-peers` reads them. Reads the
 * lockfiles only: it spawns no package manager, writes no file and fetches nothing. Returns what failed, empty when every
 * such peer is inside its range.
 */
export function checkAntelopejsPeers(root: string): string {
  return pnpmLockfiles(root)
    .map((file) => {
      try {
        return lockfileDocuments(join(root, file))
          .flatMap((document) =>
            (mapping(document, "importers")
              ? keys(mapping(document, "importers"))
              : ["."]
            ).map((importer) => importerReport(file, document, importer)),
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
