#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";

import {
  checkInterfaceRanges,
  describeViolation,
  type PackageManifest,
} from "../interface-ranges.ts";

// Every manifest in the repository by default, whatever directory the lint
// runs from: playgrounds and front-end layers are loaded by the runtime too, a
// playground is where a stale interface range first broke a startup, and an
// implemented interface usually sits in a sibling package.
function trackedManifests(): string[] {
  const git = (args: string[]): string =>
    execFileSync("git", args, { encoding: "utf8" }).trim();
  const root = git(["rev-parse", "--show-toplevel"]);
  return git(["-C", root, "ls-files", "--", "package.json", "**/package.json"])
    .split("\n")
    .filter((line) => line.length > 0)
    .map((file) => relative(process.cwd(), join(root, file)));
}

function main(): number {
  const paths =
    process.argv.length > 2 ? process.argv.slice(2) : trackedManifests();
  const manifests = paths.map((path) => ({
    path,
    manifest: JSON.parse(readFileSync(path, "utf8")) as PackageManifest,
  }));
  const localVersions = new Map<string, string>();
  for (const { manifest } of manifests) {
    if (manifest.name && manifest.version)
      localVersions.set(manifest.name, manifest.version);
  }
  let failures = 0;
  for (const { path, manifest } of manifests) {
    for (const violation of checkInterfaceRanges(manifest, localVersions)) {
      console.error(`${path}: ${describeViolation(violation)}`);
      failures += 1;
    }
  }
  if (failures > 0) {
    console.error(
      `\n${failures} interface range(s) would stop a module from starting at the next interface release.`,
    );
    return 1;
  }
  return 0;
}

process.exitCode = main();
