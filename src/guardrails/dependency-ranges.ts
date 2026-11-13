/**
 * An `@antelopejs/*` package ships breaking changes in minor releases, on 0.x
 * and from 1.0 alike, so a range open past the next minor of its floor lets an
 * install resolve a breaking release its dependent was never built against.
 * Every range on one stops below that minor: `>=0.4.0 <0.5.0` on 0.x,
 * `~1.2.0` from 1.0. A narrower range, such as an exact pin, fails too:
 * `@antelopejs/core` keeps one copy of each interface and refuses to start a
 * module whose range that copy falls outside, so a pin breaks startup at the
 * next patch release.
 */

const ANTELOPEJS_SCOPE = "@antelopejs/";

/** A package linked from the workspace is the copy the dependent builds against, not a release it resolves. */
const LOCAL_SPEC_PREFIXES = ["workspace:", "file:", "link:"];

const CHECKED_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;

type Field = (typeof CHECKED_FIELDS)[number];

type Version = readonly [major: number, minor: number, patch: number];

/** The releases a spec admits: from `floor` up to, and not including, `ceiling`. */
interface Bounds {
  floor: Version;
  ceiling: Version;
}

export type PackageManifest = {
  name?: string;
  version?: string;
} & { [field in Field]?: Record<string, string> };

export interface RangeViolation {
  field: Field;
  name: string;
  spec: string;
  /** The version of `name` that sits in the same repository, which the range must admit. */
  local?: string;
  /** The spec to use instead, when a floor can be read from `spec` or `local`. */
  expected?: string;
}

const VERSION = String.raw`v?(\d+)\.(\d+)\.(\d+)`;

const LEADING_VERSION = new RegExp(String.raw`^(?:>=|[~^=])?\s*${VERSION}`);

const nextMinor = ([major, minor]: Version): Version => [major, minor + 1, 0];

/** The first release a caret excludes: the next major from 1.0, the next minor on 0.x, the next patch on 0.0.x. */
function caretCeiling([major, minor, patch]: Version): Version {
  if (major > 0) return [major + 1, 0, 0];
  return minor > 0 ? [0, minor + 1, 0] : [0, 0, patch + 1];
}

/** Each range syntax this check reads, matched whole, with the ceiling it puts on the floor its first three groups hold. */
const RANGE_SYNTAXES: readonly {
  pattern: RegExp;
  ceiling: (floor: Version, match: RegExpExecArray) => Version;
}[] = [
  {
    pattern: new RegExp(
      String.raw`^>=\s*${VERSION}\s+<\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$`,
    ),
    ceiling: (_floor, match) => [
      Number(match[4]),
      Number(match[5] ?? 0),
      Number(match[6] ?? 0),
    ],
  },
  { pattern: new RegExp(String.raw`^~${VERSION}$`), ceiling: nextMinor },
  { pattern: new RegExp(String.raw`^\^${VERSION}$`), ceiling: caretCeiling },
  {
    pattern: new RegExp(String.raw`^=?${VERSION}$`),
    ceiling: ([major, minor, patch]) => [major, minor, patch + 1],
  },
];

const toVersion = (match: RegExpExecArray): Version => [
  Number(match[1]),
  Number(match[2]),
  Number(match[3]),
];

function readBounds(spec: string): Bounds | undefined {
  for (const { pattern, ceiling } of RANGE_SYNTAXES) {
    const match = pattern.exec(spec);
    if (!match) continue;
    const floor = toVersion(match);
    return { floor, ceiling: ceiling(floor, match) };
  }
  return undefined;
}

/** The lowest release `spec` names, read from its start even when the rest is a shape this check does not read. */
export function readFloor(spec: string): Version | undefined {
  const match = LEADING_VERSION.exec(spec.trim());
  return match ? toVersion(match) : undefined;
}

const formatVersion = ([major, minor, patch]: Version): string =>
  `${major}.${minor}.${patch}`;

function compareVersions(a: Version, b: Version): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/** The range to declare for releases from `floor`: a bounded range on 0.x, a tilde from 1.0. */
function cappedRange(floor: Version): string {
  return floor[0] === 0
    ? `>=${formatVersion(floor)} <${formatVersion(nextMinor(floor))}`
    : `~${formatVersion(floor)}`;
}

function isCapped(
  bounds: Bounds | undefined,
  local: Version | undefined,
): boolean {
  if (!bounds) return false;
  const { floor, ceiling } = bounds;
  if (compareVersions(ceiling, nextMinor(floor)) !== 0) return false;
  return (
    local === undefined ||
    (compareVersions(local, floor) >= 0 && compareVersions(local, ceiling) < 0)
  );
}

function isLocalSpec(spec: string): boolean {
  return LOCAL_SPEC_PREFIXES.some((prefix) => spec.startsWith(prefix));
}

/** Whether `manifest` declares an `@antelopejs/*` package in a field this check reads. */
export function declaresAntelopePackage(manifest: PackageManifest): boolean {
  return CHECKED_FIELDS.some((field) =>
    Object.keys(manifest[field] ?? {}).some((name) =>
      name.startsWith(ANTELOPEJS_SCOPE),
    ),
  );
}

/** The version of each named package among `manifests`, the packages that sit in the same repository. */
export function localVersions(
  manifests: Iterable<PackageManifest>,
): Map<string, string> {
  const versions = new Map<string, string>();
  for (const { name, version } of manifests)
    if (name && version) versions.set(name, version);
  return versions;
}

/**
 * The `@antelopejs/*` ranges of `manifest` that do not stop at the next minor
 * of their floor. `localVersions` holds the versions of the packages that sit
 * in the same repository: a range on one of them must also admit that
 * version, which then decides the minor to stop below.
 */
export function checkDependencyRanges(
  manifest: PackageManifest,
  localVersions: ReadonlyMap<string, string> = new Map(),
): RangeViolation[] {
  const violations: RangeViolation[] = [];
  for (const field of CHECKED_FIELDS) {
    for (const [name, spec] of Object.entries(manifest[field] ?? {})) {
      if (!name.startsWith(ANTELOPEJS_SCOPE) || isLocalSpec(spec)) continue;
      const local = localVersions.get(name);
      const localVersion = local === undefined ? undefined : readFloor(local);
      const bounds = readBounds(spec.trim());
      if (isCapped(bounds, localVersion)) continue;
      const floor = localVersion ?? bounds?.floor ?? readFloor(spec);
      violations.push({
        field,
        name,
        spec,
        ...(local !== undefined && { local }),
        ...(floor && { expected: cappedRange(floor) }),
      });
    }
  }
  return violations;
}

export function describeViolation(violation: RangeViolation): string {
  const { field, name, spec, local, expected } = violation;
  const holds =
    local === undefined
      ? ""
      : ` and admit ${local}, the version in this repository`;
  const fix = expected
    ? `use "${expected}"`
    : "declare it as >=<floor> <next minor> on 0.x or ~<floor> from 1.0";
  return `${field}["${name}"] is "${spec}": AntelopeJS packages ship breaking changes in minor releases, so it must stop below the next minor${holds}; ${fix}`;
}
