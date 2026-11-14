import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { validRange } from "semver";

import { parseJson } from "../garden/json.ts";
import { tagVersion } from "../garden/npm.ts";
import { cappedReplacement } from "./dependency-ranges.ts";
import { workspaceDirectories } from "./docs-compat.ts";
import { parseManifest } from "./package.ts";

/** An object literal holding no other, such as a config example's `source: { package, version }`. */
const FLAT_OBJECT = /\{[^{}]*\}/g;

const ANTELOPEJS_SCOPE = "@antelopejs/";

const DEFAULT_REGISTRY = "https://registry.npmjs.org/";

/** How long one read of a package's dist-tags may take before it counts as failed. */
const REGISTRY_TIMEOUT_MS = 3000;

/** How many times a read that failed or timed out is made before the version counts as unreadable. */
const REGISTRY_ATTEMPTS = 2;

/** A package of the repository, keyed by its `name`: its `version` and the `package.json`, relative to the root, that declares it. */
interface OwnPackage {
  version: string;
  manifest: string;
}

/** A `version` range a README's config example gives an `@antelopejs/*` package, with the repository's own copy when it has one. */
interface ReadmeExample {
  readme: string;
  line: number;
  name: string;
  range: string;
  owner: OwnPackage | undefined;
}

/** The newest version of a package and where it was read, as the check names it. */
interface Newest {
  version: string;
  source: string;
}

function stringField(body: string, key: string): RegExpExecArray | null {
  return new RegExp(
    String.raw`(?<![\w$-])["']?${key}["']?\s*:\s*["']([^"'\n]+)["']`,
  ).exec(body);
}

function relative(directory: string, file: string): string {
  return directory ? `${directory}/${file}` : file;
}

/** The repository root and its workspace package directories, relative to `root`, the root as `""`. */
function packageDirectories(root: string): string[] {
  return ["", ...workspaceDirectories(root)];
}

function ownPackages(root: string): Map<string, OwnPackage> {
  const packages = new Map<string, OwnPackage>();
  for (const directory of packageDirectories(root)) {
    const manifest = relative(directory, "package.json");
    const { name, version } = parseManifest(
      readFileSync(join(root, manifest), "utf8"),
    );
    if (name && version) packages.set(name, { version, manifest });
  }
  return packages;
}

function examplesIn(
  readme: string,
  text: string,
  packages: Map<string, OwnPackage>,
): ReadmeExample[] {
  return [...text.matchAll(FLAT_OBJECT)].flatMap((object) => {
    const name = stringField(object[0], "package")?.[1];
    const field = stringField(object[0], "version");
    const range = field?.[1];
    if (!name?.startsWith(ANTELOPEJS_SCOPE) || !field || range === undefined)
      return [];
    const line = text.slice(0, object.index + field.index).split("\n").length;
    return [{ readme, line, name, range, owner: packages.get(name) }];
  });
}

/** The config examples in the `README.md` of the root and of each workspace package that give an `@antelopejs/*` package a `version`. */
export function readmeExamples(root: string): ReadmeExample[] {
  const readmes = packageDirectories(root)
    .map((directory) => relative(directory, "README.md"))
    .filter((readme) => existsSync(join(root, readme)));
  if (!readmes.length) return [];
  const packages = ownPackages(root);
  return readmes.flatMap((readme) =>
    examplesIn(readme, readFileSync(join(root, readme), "utf8"), packages),
  );
}

function registry(): string {
  const configured =
    process.env.npm_config_registry || process.env.NPM_CONFIG_REGISTRY;
  if (!configured) return DEFAULT_REGISTRY;
  return configured.endsWith("/") ? configured : `${configured}/`;
}

/** The `latest` dist-tag of `name` on the registry npm is configured with, or `undefined` when it cannot be read within {@link REGISTRY_ATTEMPTS} reads of {@link REGISTRY_TIMEOUT_MS} each. */
async function publishedVersion(name: string): Promise<string | undefined> {
  for (let attempt = 0; attempt < REGISTRY_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(
        new URL(name.replace("/", "%2f"), registry()),
        {
          headers: { accept: "application/vnd.npm.install-v1+json" },
          signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
        },
      );
      return response.ok
        ? tagVersion(parseJson(await response.text()), "latest")
        : undefined;
    } catch {
      continue;
    }
  }
  return undefined;
}

async function newestVersions(
  examples: readonly ReadmeExample[],
): Promise<Map<string, Newest | undefined>> {
  const names = [...new Set(examples.map(({ name }) => name))];
  const entries = await Promise.all(
    names.map(async (name): Promise<[string, Newest | undefined]> => {
      const owner = examples.find((example) => example.name === name)?.owner;
      if (owner)
        return [
          name,
          {
            version: owner.version,
            source: `the version in ${owner.manifest}`,
          },
        ];
      const version = await publishedVersion(name);
      return [
        name,
        version === undefined
          ? undefined
          : { version, source: "its newest published version" },
      ];
    }),
  );
  return new Map(entries);
}

function describe(
  { readme, line, name, range }: ReadmeExample,
  newest: Newest | undefined,
): string {
  if (newest === undefined)
    return `${readme}:${line} gives ${name} the version range "${range}", but its newest published version could not be read from ${registry()}.\n`;
  const expected = cappedReplacement(range, newest.version);
  if (expected === undefined) return "";
  return `${readme}:${line} gives ${name} the version range "${range}", which does not stop below the next minor of ${newest.version}, ${newest.source}. Use "${expected}".\n`;
}

/**
 * Fails for each README config example whose `@antelopejs/*` `version` range does not stop below the next minor of the
 * package's newest version and admit it, naming the README line and the range to use. The newest version is the one in
 * the repository's own `package.json` for its own packages, and the registry's `latest` dist-tag for any other. A value
 * that is not a range, such as a dist-tag, passes.
 */
export async function checkReadmeVersion(root: string): Promise<string> {
  const examples = readmeExamples(root).filter(
    ({ range }) => validRange(range) !== null,
  );
  const newest = await newestVersions(examples);
  return examples
    .map((example) => describe(example, newest.get(example.name)))
    .join("");
}
