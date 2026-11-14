import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { satisfies, validRange } from "semver";

import { workspaceDirectories } from "./docs-compat.ts";
import { parseManifest } from "./package.ts";

/** An object literal holding no other, such as a config example's `source: { package, version }`. */
const FLAT_OBJECT = /\{[^{}]*\}/g;

/** A package of the repository, keyed by its `name`: its `version` and the `package.json`, relative to the root, that declares it. */
interface OwnPackage {
  version: string;
  manifest: string;
}

/** A `version` range a README's config example gives one of the repository's own packages. */
interface ReadmeExample {
  readme: string;
  line: number;
  name: string;
  range: string;
  owner: OwnPackage;
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
    const owner = name === undefined ? undefined : packages.get(name);
    const field = stringField(object[0], "version");
    const range = field?.[1];
    if (!name || !owner || !field || range === undefined) return [];
    const line = text.slice(0, object.index + field.index).split("\n").length;
    return [{ readme, line, name, range, owner }];
  });
}

/** The config examples in the `README.md` of the root and of each workspace package that give one of the repository's own packages, by its `package.json` `name`, a `version`. */
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

/**
 * Fails for each README config example whose `version` range, read as npm reads it, does not admit the `version` in
 * the named package's `package.json`, naming the README line; empty when every one does. A value that is not a range,
 * such as a dist-tag, passes.
 */
export function checkReadmeVersion(root: string): string {
  return readmeExamples(root)
    .filter(
      ({ range, owner }) =>
        validRange(range) !== null && !satisfies(owner.version, range),
    )
    .map(
      ({ readme, line, name, range, owner }) =>
        `${readme}:${line} gives ${name} the version range "${range}", which does not admit ${owner.version}, the version in ${owner.manifest}. Set a range that admits it.\n`,
    )
    .join("");
}
