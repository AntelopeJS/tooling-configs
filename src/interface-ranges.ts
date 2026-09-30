/**
 * At startup `@antelopejs/core` keeps one copy of each interface package, the
 * one its implementing module installed, and refuses to start when any loaded
 * module declares a range that copy falls outside. An exact pin (`0.1.7`) or a
 * 0.x caret (`^0.1.2` means `<0.2.0`) therefore stops a module from starting
 * as soon as the implementer resolves the next interface release, with no
 * change to the module itself.
 *
 * A consumer accepts every release from its floor up to the next breaking one
 * (`>=0.1.7 <1.0.0`). The module that implements an interface is the opposite
 * case: it must never be handed a breaking minor it does not implement, so it
 * caps the range below the next minor (`>=0.3.0 <0.4.0`) while the interface
 * is 0.x.
 */

const INTERFACE_PACKAGE_PREFIX = "@antelopejs/interface-";

// A module's own interface linked from the workspace is the copy it builds
// against, not a release it resolves.
const LOCAL_SPEC_PREFIXES = ["workspace:", "file:", "link:"];

// The fields `@antelopejs/core` checks at startup.
const CHECKED_FIELDS = ["dependencies", "optionalDependencies"] as const;

const BOUNDED_RANGE = /^>=(\d+)\.(\d+)\.(\d+) <(\d+)\.(\d+)\.(\d+)$/;
const SINGLE_VERSION = /^[\^~=]?v?(\d+)\.(\d+)\.(\d+)$/;

type Version = readonly [major: number, minor: number, patch: number];

export type RangeRole = "consumer" | "implementer";

export interface PackageManifest {
  name?: string;
  version?: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  antelopeJs?: { implements?: string[] };
}

export interface RangeViolation {
  field: (typeof CHECKED_FIELDS)[number];
  name: string;
  spec: string;
  role: RangeRole;
  /** The spec to use instead, when the floor can be read from `spec`. */
  expected?: string;
}

const formatVersion = ([major, minor, patch]: Version): string =>
  `${major}.${minor}.${patch}`;

const sameVersion = (a: Version, b: Version): boolean =>
  a[0] === b[0] && a[1] === b[1] && a[2] === b[2];

/** The first release a module declaring `floor` must not be handed. */
export function rangeCeiling(floor: Version, role: RangeRole): Version {
  const [major, minor] = floor;
  if (major > 0) return [major + 1, 0, 0];
  return role === "implementer" ? [0, minor + 1, 0] : [1, 0, 0];
}

export function expectedRange(floor: Version, role: RangeRole): string {
  return `>=${formatVersion(floor)} <${formatVersion(rangeCeiling(floor, role))}`;
}

function toVersion(match: RegExpExecArray, offset: number): Version {
  return [
    Number(match[offset]),
    Number(match[offset + 1]),
    Number(match[offset + 2]),
  ];
}

/** The lowest release `spec` accepts, when it is a shape this check reads. */
export function readFloor(spec: string): Version | undefined {
  const bounded = BOUNDED_RANGE.exec(spec);
  if (bounded) return toVersion(bounded, 1);
  const single = SINGLE_VERSION.exec(spec);
  return single ? toVersion(single, 1) : undefined;
}

function compareVersions(a: Version, b: Version): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

function isAcceptedRange(
  spec: string,
  role: RangeRole,
  local: Version | undefined,
): boolean {
  const bounded = BOUNDED_RANGE.exec(spec);
  if (!bounded) return false;
  const floor = toVersion(bounded, 1);
  const ceiling = toVersion(bounded, 4);
  if (!sameVersion(ceiling, rangeCeiling(floor, role))) return false;
  // The interface this package builds against must be one it accepts.
  return (
    local === undefined ||
    (compareVersions(local, floor) >= 0 && compareVersions(local, ceiling) < 0)
  );
}

function isLocalSpec(spec: string): boolean {
  return LOCAL_SPEC_PREFIXES.some((prefix) => spec.startsWith(prefix));
}

/**
 * `localVersions` holds the versions of the packages that sit in the same
 * repository. An implemented interface is usually one of them, and its
 * version, rather than the declared floor, decides the minor to stop below.
 */
export function checkInterfaceRanges(
  manifest: PackageManifest,
  localVersions: ReadonlyMap<string, string> = new Map(),
): RangeViolation[] {
  const implemented = new Set(manifest.antelopeJs?.implements ?? []);
  const violations: RangeViolation[] = [];
  for (const field of CHECKED_FIELDS) {
    for (const [name, spec] of Object.entries(manifest[field] ?? {})) {
      if (!name.startsWith(INTERFACE_PACKAGE_PREFIX) || isLocalSpec(spec))
        continue;
      const role: RangeRole = implemented.has(name)
        ? "implementer"
        : "consumer";
      const localVersion = localVersions.get(name);
      const local =
        role === "implementer" && localVersion !== undefined
          ? readFloor(localVersion)
          : undefined;
      if (isAcceptedRange(spec, role, local)) continue;
      const floor = local ?? readFloor(spec);
      violations.push({
        field,
        name,
        spec,
        role,
        expected: floor ? expectedRange(floor, role) : undefined,
      });
    }
  }
  return violations;
}

export function describeViolation(violation: RangeViolation): string {
  const { field, name, spec, role, expected } = violation;
  const fix = expected
    ? `use "${expected}"`
    : role === "implementer"
      ? "declare it as >=<floor> <next minor>"
      : "declare it as >=<floor> <1.0.0";
  const reason =
    role === "implementer"
      ? "this package implements it, so it must stop below the next minor"
      : "it must accept every release up to the next breaking one";
  return `${field}["${name}"] is "${spec}": ${reason}; ${fix}`;
}
