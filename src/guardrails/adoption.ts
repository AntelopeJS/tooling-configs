import { spawnSync } from "node:child_process";

import { isPackRelease } from "./ceilings.ts";
import { toolingVersions } from "./package.ts";

/**
 * Each rule the preset turned on after repositories recorded their ratchet,
 * with the first pack release that enables it: the release after the
 * `version` in package.json when the rule lands. `ratchet:update` records
 * today's count of a listed rule once, in a repository whose recorded release
 * predates it; a rule not listed here is never adopted.
 */
export const PACK_NEW_RULES = new Map([
  ["antelopejs/no-inherited-key-lookup", "0.2.17"],
  ["antelopejs/no-presence-only-type-guard", "0.2.17"],
  ["typescript/no-unnecessary-type-parameters", "0.2.17"],
  ["typescript/no-unsafe-argument", "0.2.17"],
  ["typescript/no-unsafe-assignment", "0.2.17"],
  ["typescript/no-unsafe-return", "0.2.17"],
  ["typescript/use-unknown-in-catch-callback-variable", "0.2.17"],
]);

function parts(release: string): number[] {
  return release.split(".").map(Number);
}

/** Orders two `major.minor.patch` releases. */
export function compareReleases(a: string, b: string): number {
  const [left, right] = [parts(a), parts(b)];
  for (let index = 0; index < 3; index += 1)
    if (left[index] !== right[index]) return left[index] - right[index];
  return 0;
}

function latest(releases: (string | undefined)[]): string | undefined {
  let best: string | undefined;
  for (const release of releases)
    if (
      release !== undefined &&
      isPackRelease(release) &&
      (best === undefined || compareReleases(release, best) > 0)
    )
      best = release;
  return best;
}

function show(root: string, revision: string, path: string) {
  const result = spawnSync("git", ["show", `${revision}:${path}`], {
    cwd: root,
    encoding: "utf8",
  });
  return result.status === 0 ? result.stdout : undefined;
}

const LOCKED = [
  {
    file: "pnpm-lock.yaml",
    pattern:
      /^ {6}'@antelopejs\/tooling-configs':\n {8}specifier: [^\n]*\n {8}version: (\d+\.\d+\.\d+)/mu,
  },
  {
    file: "package-lock.json",
    pattern:
      /"node_modules\/@antelopejs\/tooling-configs":\s*\{[^{}]*?"version":\s*"(\d+\.\d+\.\d+)"/u,
  },
];

/** The pack release the root importer of the pnpm or npm lockfile at `revision` installs. */
export function lockedRelease(
  root: string,
  revision: string,
): string | undefined {
  let release: string | undefined;
  for (const { file, pattern } of LOCKED) {
    const text = show(root, revision, file);
    if (text !== undefined) {
      release = pattern.exec(text)?.[1];
      break;
    }
  }
  return latest([release]);
}

/**
 * The release a repository adopted the pack-new rules up to: the later of
 * its ratchet's record and the pack its lockfile at `revision` installs. A
 * repository with neither predates every listed rule.
 */
export function adoptedRelease(
  root: string,
  recorded: string | undefined,
  revision: string | undefined,
): string | undefined {
  return latest([
    recorded,
    revision === undefined ? undefined : lockedRelease(root, revision),
  ]);
}

/** The release that enabled `rule` when it is later than `adopted`, else undefined. */
export function newlyEnabled(
  rule: string,
  adopted: string | undefined,
): string | undefined {
  const since = PACK_NEW_RULES.get(rule);
  if (since === undefined) return undefined;
  return adopted === undefined || compareReleases(since, adopted) > 0
    ? since
    : undefined;
}

/** The release an update records: the latest of `adopted`, the installed pack and every listed rule's release, so no listed rule is adopted twice. */
export function recordedRelease(adopted: string | undefined): string {
  return (
    latest([adopted, toolingVersions().pack, ...PACK_NEW_RULES.values()]) ??
    "0.0.0"
  );
}
