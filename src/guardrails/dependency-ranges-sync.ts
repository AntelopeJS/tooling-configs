import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  gtr,
  minVersion,
  prerelease,
  Range,
  satisfies,
  valid,
  validRange,
} from "semver";

import {
  cappedReplacement,
  checkDependencyRanges,
  declaresAntelopePackage,
  describeViolation,
  type InterfaceRange,
  interfaceRanges,
  localVersions,
  type RangeViolation,
  releasedSpec,
} from "./dependency-ranges.ts";
import { trackedManifests } from "./files.ts";
import {
  packageManager,
  parseManifest,
  serializeManifest,
  type Manifest,
} from "./package.ts";
import { DMS_PACKAGES } from "./docs-modules.ts";
import {
  type ImplementingRelease,
  implementingRelease,
  publishedVersion,
} from "./registry.ts";
import { runPnpm } from "./run-pnpm.ts";

/** The manifests whose ranges moved, a note per moved range, and why the lockfile could not follow. */
export interface RangeMoves {
  paths: string[];
  notes: string[];
  errors: string[];
}

interface TrackedManifest {
  path: string;
  text: string;
  manifest: Manifest;
}

/** Each tracked manifest that parses; a fixture that is not JSON is not a package this repository releases. */
function tracked(root: string): TrackedManifest[] {
  return trackedManifests(root).flatMap((path) => {
    try {
      const text = readFileSync(join(root, path), "utf8");
      return [{ path, text, manifest: parseManifest(text) }];
    } catch {
      return [];
    }
  });
}

function movedNote(path: string, violation: RangeViolation): string {
  return `${path}: moved ${violation.field}["${violation.name}"] from "${violation.spec}" to "${violation.expected}", the range of the version this repository holds.`;
}

/** The relock failure, after which the moved manifests are back as they were so the next sync moves them again. */
function writeAndRelock(
  root: string,
  manifests: readonly TrackedManifest[],
  moved: ReadonlyMap<string, { before: string; after: string }>,
): string | undefined {
  const rootManifest = manifests.find(({ path }) => path === "package.json");
  const manager = packageManager(rootManifest?.manifest ?? {});
  if (manager !== "pnpm")
    return `${manager} is not pnpm, so sync cannot relock them.`;
  for (const [path, { after }] of moved) writeFileSync(join(root, path), after);
  const failure = runPnpm(root, ["install", "--lockfile-only"]);
  if (failure !== undefined)
    for (const [path, { before }] of moved)
      writeFileSync(join(root, path), before);
  return failure;
}

/**
 * Moves each tracked manifest's range on a package that sits in this
 * repository to the range `checkDependencyRanges` expects, then relocks, or
 * leaves every manifest as it was when the relock fails. A minor release of
 * that package otherwise leaves its dependents' ranges below the new version
 * and fails the `dependency:ranges` check on the release commit. It runs
 * before the rest of sync, which then plans the docs-compat READMEs from the
 * moved ranges and the new lockfile. `check` reports the moves without
 * writing.
 */
export function moveDependencyRanges(root: string, check: boolean): RangeMoves {
  const manifests = tracked(root);
  const versions = localVersions(manifests.map(({ manifest }) => manifest));
  const moves: RangeMoves = { paths: [], notes: [], errors: [] };
  const moved = new Map<string, { before: string; after: string }>();
  for (const { path, text, manifest } of manifests) {
    const fixes = checkDependencyRanges(manifest, versions).filter(
      (violation) =>
        violation.local !== undefined && violation.expected !== undefined,
    );
    if (!fixes.length) continue;
    for (const { field, name, expected } of fixes) {
      const dependencies = manifest[field];
      if (dependencies && expected) dependencies[name] = expected;
    }
    moved.set(path, { before: text, after: serializeManifest(manifest, text) });
    moves.paths.push(path);
    moves.notes.push(...fixes.map((fix) => movedNote(path, fix)));
  }
  if (check || !moved.size) return moves;
  const failure = writeAndRelock(root, manifests, moved);
  if (failure !== undefined)
    moves.errors.push(
      `Left the dependency ranges in ${moves.paths.join(", ")} unmoved: the lockfile could not follow them. ${failure}`,
    );
  return moves;
}

/** Whether a tracked manifest declares an `@antelopejs/*` package, so `checkRepositoryRanges` has a range to read. */
export function hasDependencyRanges(root: string): boolean {
  return tracked(root).some(({ manifest }) =>
    declaresAntelopePackage(manifest),
  );
}

/** A capped `@antelopejs/interface-*` range on a package outside this repository, which the newest release on the registry must not outgrow. */
interface PublishedRange extends InterfaceRange {
  path: string;
}

/** Why a published range cannot start beside a release, and the range to use instead. */
interface StaleFinding {
  reason: string;
  expected: string;
}

function belowNewest(
  spec: string,
  version: string | undefined,
): StaleFinding | undefined {
  if (
    version === undefined ||
    valid(version) === null ||
    prerelease(version) !== null ||
    !gtr(version, spec)
  )
    return undefined;
  const expected = cappedReplacement(spec, version);
  return expected === undefined
    ? undefined
    : {
        reason: `which stops below ${version}, its newest published version`,
        expected,
      };
}

/** The lowest release `range` admits, without the prerelease suffix a floor such as `^0.10.0-rc.1` carries. */
function stableFloor(range: string): string | undefined {
  const floor = minVersion(range);
  return floor === null
    ? undefined
    : `${floor.major}.${floor.minor}.${floor.patch}`;
}

/** Whether one release admitted by `a` is also admitted by `b`, counting releases only, as an install resolves them. */
function sharesRelease(a: string, b: string): boolean {
  return new Range(a).set.some((left) =>
    new Range(b).set.some((right) => {
      const both = [...left, ...right].join(" ");
      const floor = stableFloor(both);
      return floor !== undefined && satisfies(floor, both);
    }),
  );
}

/** A stable DMS release that implements an interface, and the range it declares on that interface. */
interface Implementation {
  release: ImplementingRelease;
  range: string;
}

/** The implementation of `name` in each of `releases` that is not a prerelease and declares a range semver reads. */
function implementations(
  name: string,
  releases: readonly ImplementingRelease[],
): Implementation[] {
  return releases.flatMap((release) => {
    const range = release.implements.get(name);
    return range === undefined ||
      prerelease(release.version) !== null ||
      validRange(range) === null
      ? []
      : [{ release, range }];
  });
}

function outsideImplemented(
  spec: string,
  { release, range }: Implementation,
): StaleFinding | undefined {
  if (sharesRelease(spec, range)) return undefined;
  const floor = stableFloor(range);
  const expected =
    floor === undefined ? undefined : cappedReplacement(spec, floor);
  return expected === undefined
    ? undefined
    : {
        reason: `which excludes "${range}", the range ${release.name} ${release.version}, its newest release, implements it on`,
        expected,
      };
}

/** The newest release of each DMS package outside this repository that could be read, and whether every published one could. */
async function dmsReleases(
  local: ReadonlySet<string>,
): Promise<{ releases: ImplementingRelease[]; complete: boolean }> {
  const reads = await Promise.all(
    DMS_PACKAGES.filter((name) => !local.has(name)).map(implementingRelease),
  );
  return {
    releases: reads.filter(
      (read) => read !== undefined && read !== "unpublished",
    ),
    complete: !reads.includes(undefined),
  };
}

/**
 * One line per range among `ranges` that shares no release with the range the newest release of a DMS package outside
 * `local` implements its interface on, since a project loads the interface version that release is built against. An
 * interface no such release implements is held instead to the `latest` dist-tag of its package: one line when every
 * release the range admits sits below it, and only when every published DMS release could be read, since an unread one
 * may implement it. An exact pin on a preview is judged as the capped range on its release, the range the release train
 * publishes in its place. A line that gives the fix an earlier one gave is skipped. A package whose release cannot be read,
 * or whose `latest` is a prerelease, is skipped, so a registry outage leaves only the cap rule deciding the step.
 */
async function staleRanges(
  ranges: readonly PublishedRange[],
  local: ReadonlySet<string>,
): Promise<string[]> {
  if (!ranges.length) return [];
  const names = [...new Set(ranges.map(({ name }) => name))];
  const [newest, { releases, complete }] = await Promise.all([
    Promise.all(
      names.map(async (name) => [name, await publishedVersion(name)] as const),
    ).then((entries) => new Map(entries)),
    dmsReleases(local),
  ]);
  return ranges.flatMap(({ path, field, name, spec }) => {
    const released = releasedSpec(spec);
    if (validRange(released) === null) return [];
    const implemented = implementations(name, releases);
    const findings = (
      implemented.length
        ? implemented.map((implementation) =>
            outsideImplemented(released, implementation),
          )
        : complete
          ? [belowNewest(released, newest.get(name))]
          : []
    ).filter((finding) => finding !== undefined);
    return findings
      .filter(
        ({ expected }, index) =>
          findings.findIndex((finding) => finding.expected === expected) ===
          index,
      )
      .map(
        ({ reason, expected }) =>
          `${path}: ${field}["${name}"] is "${spec}", ${reason}, and @antelopejs/core loads one copy of each interface; use "${expected}"\n`,
      );
  });
}

/**
 * Each `@antelopejs/*` range in a tracked manifest that does not stop below the next minor, and each capped
 * `@antelopejs/interface-*` range on a package outside this repository that the newest DMS release implementing it, or
 * else its newest published release, does not admit, one line each; empty when every range passes.
 */
export async function checkRepositoryRanges(root: string): Promise<string> {
  const manifests = tracked(root);
  const versions = localVersions(manifests.map(({ manifest }) => manifest));
  const capped: string[] = [];
  const published: PublishedRange[] = [];
  for (const { path, manifest } of manifests) {
    const violations = checkDependencyRanges(manifest, versions);
    capped.push(
      ...violations.map(
        (violation) => `${path}: ${describeViolation(violation)}\n`,
      ),
    );
    published.push(
      ...interfaceRanges(manifest)
        .filter(
          ({ field, name }) =>
            !versions.has(name) &&
            !violations.some(
              (violation) =>
                violation.field === field && violation.name === name,
            ),
        )
        .map((range) => ({ path, ...range })),
    );
  }
  const local = new Set(
    manifests.flatMap(({ manifest: { name } }) => (name ? [name] : [])),
  );
  return [...capped, ...(await staleRanges(published, local))].join("");
}
