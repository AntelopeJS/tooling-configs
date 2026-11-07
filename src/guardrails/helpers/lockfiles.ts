import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { stringify } from "yaml";

/** The dependency fields of a manifest, by package name and specifier. */
export interface DependencyFields {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

/** What a run that writes nothing leaves as it was: a lockfile's inode and mtime, and its folder's mtime and listing. */
export function folderStamp(folder: string, lockfile: string) {
  const stats = statSync(join(folder, lockfile));
  return {
    inode: stats.ino,
    lockfile: stats.mtimeMs,
    folder: statSync(folder).mtimeMs,
    entries: readdirSync(folder).sort(),
    nodeModules: existsSync(join(folder, "node_modules")),
  };
}

/** A private package with no dependency. */
export const NO_DEPENDENCIES = {
  name: "fixture",
  version: "1.0.0",
  private: true,
};

function locked(specifiers: Record<string, string> = {}) {
  return Object.fromEntries(
    Object.entries(specifiers).map(([name, specifier]) => [
      name,
      { specifier, version: specifier.replace(/^[\^~]/u, "") },
    ]),
  );
}

/** A version 9 `pnpm-lock.yaml` with these importers, as pnpm writes it: default settings and each specifier locked to its own version. */
export function pnpmLock(
  importers: Record<string, DependencyFields>,
  extra: {
    overrides?: Record<string, string>;
    settings?: Record<string, boolean>;
  } = {},
): string {
  return stringify({
    lockfileVersion: "9.0",
    settings: {
      autoInstallPeers: true,
      excludeLinksFromLockfile: false,
      ...extra.settings,
    },
    ...(extra.overrides && { overrides: extra.overrides }),
    importers: Object.fromEntries(
      Object.entries(importers).map(([importer, fields]) => [
        importer,
        Object.fromEntries(
          (
            ["dependencies", "devDependencies", "optionalDependencies"] as const
          ).flatMap((field) =>
            fields[field] ? [[field, locked(fields[field])]] : [],
          ),
        ),
      ]),
    ),
  });
}

/** A version 3 `package-lock.json` whose root entry declares these fields. */
export function npmLock(fields: DependencyFields): string {
  return JSON.stringify({
    ...NO_DEPENDENCIES,
    lockfileVersion: 3,
    requires: true,
    packages: {
      "": { name: NO_DEPENDENCIES.name, version: "1.0.0", ...fields },
      "node_modules/left-pad": {
        version: "1.3.0",
        resolved: "https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz",
        integrity:
          "sha512-XI5MPzVNApjAyhQzphX8BkmKsKUxD4LdyK24iZeQGinBN9yTQT3bFlCBy/aVx2HrNcqQGsdot8ghrjyrvMCoEA==",
      },
    },
  });
}
