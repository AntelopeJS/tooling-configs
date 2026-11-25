import {
  isObject,
  isString,
  type JsonObject,
  type JsonValue,
  optChild,
  optStr,
  parseJson,
  stringValues,
} from "../garden/json.ts";
import { tagVersion } from "../garden/npm.ts";

const DEFAULT_REGISTRY = "https://registry.npmjs.org/";

/** How long one registry read may take before it counts as failed. */
const REGISTRY_TIMEOUT_MS = 3000;

/** How many times a read that failed or timed out is made before the document counts as unreadable. */
const REGISTRY_ATTEMPTS = 2;

/** The dependency fields a release resolves an interface it implements from. */
const RELEASE_FIELDS = [
  "dependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;

/** The registry npm is configured with, ending in `/`. */
export function registry(): string {
  const configured =
    process.env.npm_config_registry || process.env.NPM_CONFIG_REGISTRY;
  if (!configured) return DEFAULT_REGISTRY;
  return configured.endsWith("/") ? configured : `${configured}/`;
}

/** What {@link readRegistry} returns when the registry answers that nothing is published at a path. */
const UNPUBLISHED = "unpublished";

/** The document at `path` under the {@link registry}, {@link UNPUBLISHED} when the registry answers 404, or `undefined` when it cannot be read within {@link REGISTRY_ATTEMPTS} reads of {@link REGISTRY_TIMEOUT_MS} each. */
async function readRegistry(
  path: string,
  accept: string,
): Promise<{ document: JsonValue } | typeof UNPUBLISHED | undefined> {
  for (let attempt = 0; attempt < REGISTRY_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(new URL(path, registry()), {
        headers: { accept },
        signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
      });
      if (response.status === 404) return UNPUBLISHED;
      if (!response.ok) return undefined;
      return { document: parseJson(await response.text()) };
    } catch {
      continue;
    }
  }
  return undefined;
}

const encodedName = (name: string): string => name.replace("/", "%2f");

/** The `latest` dist-tag of `name` on the {@link registry}, or `undefined` when it cannot be read. */
export async function publishedVersion(
  name: string,
): Promise<string | undefined> {
  const packument = await readRegistry(
    encodedName(name),
    "application/vnd.npm.install-v1+json",
  );
  return packument === undefined || packument === UNPUBLISHED
    ? undefined
    : tagVersion(packument.document, "latest");
}

/** The newest release of an AntelopeJS module and the range it declares on each interface it implements. */
export interface ImplementingRelease {
  name: string;
  version: string;
  /** Each interface named in the release's `antelopeJs.implements`, mapped to the range the release declares on it. */
  implements: ReadonlyMap<string, string>;
}

function declaredRange(release: JsonObject, name: string): string | undefined {
  for (const field of RELEASE_FIELDS) {
    const dependencies = Object.hasOwn(release, field)
      ? release[field]
      : undefined;
    const range =
      dependencies !== undefined && isObject(dependencies)
        ? optStr(dependencies, name)
        : undefined;
    if (range !== undefined) return range;
  }
  return undefined;
}

function implementedNames(release: JsonObject): string[] {
  const config = Object.hasOwn(release, "antelopeJs")
    ? release.antelopeJs
    : undefined;
  if (config === undefined || !isObject(config)) return [];
  const names = Object.hasOwn(config, "implements")
    ? config.implements
    : undefined;
  return Array.isArray(names) ? names.filter(isString) : [];
}

/** The release the `latest` dist-tag of `name` points at, `"unpublished"` when the registry has none, or `undefined` when it cannot be read. */
export async function implementingRelease(
  name: string,
): Promise<ImplementingRelease | typeof UNPUBLISHED | undefined> {
  const read = await readRegistry(
    `${encodedName(name)}/latest`,
    "application/json",
  );
  if (read === UNPUBLISHED) return UNPUBLISHED;
  const release = read?.document;
  if (release === undefined || !isObject(release)) return undefined;
  const version = optStr(release, "version");
  if (version === undefined) return undefined;
  const implemented = new Map<string, string>();
  for (const interfaceName of implementedNames(release)) {
    const range = declaredRange(release, interfaceName);
    if (range !== undefined) implemented.set(interfaceName, range);
  }
  return { name, version, implements: implemented };
}

/** How long one tarball download may take before it counts as failed. */
const TARBALL_TIMEOUT_MS = 30_000;

/** A published release as the abbreviated packument lists it: the ranges it declares under `peerDependencies` and its tarball URL. */
export interface ListedRelease {
  peerDependencies: ReadonlyMap<string, string>;
  tarball: string | undefined;
}

/** The dist-tags and releases of a package, keyed by tag and by version. */
export interface Packument {
  tags: ReadonlyMap<string, string>;
  releases: ReadonlyMap<string, ListedRelease>;
}

/** The {@link Packument} of `name` on the {@link registry}, or `undefined` when it is unpublished or cannot be read. */
export async function packument(name: string): Promise<Packument | undefined> {
  const read = await readRegistry(
    encodedName(name),
    "application/vnd.npm.install-v1+json",
  );
  if (read === undefined || read === UNPUBLISHED || !isObject(read.document))
    return undefined;
  const releases = new Map<string, ListedRelease>();
  for (const [version, release] of Object.entries(
    optChild(read.document, "versions") ?? {},
  ))
    if (isObject(release))
      releases.set(version, {
        peerDependencies: stringValues(optChild(release, "peerDependencies")),
        tarball: optStr(optChild(release, "dist") ?? {}, "tarball"),
      });
  return { tags: stringValues(optChild(read.document, "dist-tags")), releases };
}

/** The bytes at the tarball URL `url`, or `undefined` when they cannot be downloaded within {@link REGISTRY_ATTEMPTS} tries of {@link TARBALL_TIMEOUT_MS} each. */
export async function downloadTarball(
  url: string,
): Promise<Uint8Array | undefined> {
  for (let attempt = 0; attempt < REGISTRY_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(TARBALL_TIMEOUT_MS),
      });
      if (!response.ok) return undefined;
      return new Uint8Array(await response.arrayBuffer());
    } catch {
      continue;
    }
  }
  return undefined;
}
