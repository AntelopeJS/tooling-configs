import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** The per-repository ratchet file, at the repository root. */
export const CEILINGS_FILE = "guardrails.ratchet.json";

/**
 * Set by the ratchet when it measures: the oxlint preset then ignores the
 * ceilings and reports every rule, so the counts include the existing debt.
 */
export const MEASURE_ENV = "ANTELOPEJS_RATCHET_MEASURE";

/** Largest authored file, in bytes, tests included. */
export const MAX_FILE_BYTES = 20_000;

/**
 * Existing debt a repository is allowed to carry, and only to shrink.
 *
 * `rules` maps an oxlint rule id (`anti-slop/no-object-parameters`,
 * `eslint/max-params`) to its diagnostic count when last recorded. The preset
 * turns these rules off for `oxlint`, and the ratchet fails when a count rises.
 *
 * `oversizeFiles` maps a repository-relative path to its size in bytes when
 * last recorded. A listed file may exceed {@link MAX_FILE_BYTES} and the
 * `eslint/max-lines` limit, but may not grow past its recorded size.
 *
 * `pack` is the pack release the repository last adopted new rules at: only a
 * rule a later release enabled may be added to `rules`, by `ratchet:update`.
 */
export interface Ceilings {
  pack?: string;
  rules: Record<string, number>;
  oversizeFiles: Record<string, number>;
}

const EMPTY_CEILINGS: Ceilings = { rules: {}, oversizeFiles: {} };

/** A repository retires its ratchet once no lint or file debt remains. */
export function isRetired(ceilings: Ceilings): boolean {
  return (
    Object.values(ceilings.rules).every((count) => count === 0) &&
    Object.keys(ceilings.oversizeFiles).length === 0
  );
}

/** Finds the nearest git directory or worktree marker, falling back to cwd outside git. */
export function findGitRoot(cwd = process.cwd()): string {
  let directory = resolve(cwd);
  while (!existsSync(join(directory, ".git"))) {
    const parent = dirname(directory);
    if (parent === directory) return resolve(cwd);
    directory = parent;
  }
  return directory;
}

/** Reads the ceilings at `root`; a repository without the file has no debt. */
export function readCeilings(root: string): Ceilings {
  const path = join(root, CEILINGS_FILE);
  if (!existsSync(path)) return EMPTY_CEILINGS;
  return parseCeilings(readFileSync(path, "utf8"), path);
}

/** Whether `value` is a `major.minor.patch` release. */
export function isPackRelease(value: string): boolean {
  return /^\d+\.\d+\.\d+$/u.test(value);
}

/** Parses the ceilings file, rejecting anything but non-negative integer counts and a release for `pack`. */
export function parseCeilings(text: string, source: string): Ceilings {
  /* SAFETY: JSON text yields plain data; parseCounts checks every field before it is returned. */
  const parsed = JSON.parse(text) as Partial<Ceilings> | null;
  if (parsed === null || Array.isArray(parsed)) {
    throw new Error(
      `${source}: expected an object with "rules" and "oversizeFiles"`,
    );
  }
  if (parsed.pack !== undefined && !isPackRelease(parsed.pack))
    throw new Error(`${source}: "pack" must be a release such as "0.2.17"`);
  const ceilings: Ceilings = {
    rules: parseCounts(parsed.rules, `${source}: rules`),
    oversizeFiles: parseCounts(
      parsed.oversizeFiles,
      `${source}: oversizeFiles`,
    ),
  };
  if (parsed.pack !== undefined) ceilings.pack = parsed.pack;
  return ceilings;
}

function parseCounts(
  value: Record<string, number> | undefined | null,
  source: string,
) {
  if (value === undefined) return {};
  if (value === null || Array.isArray(value)) {
    throw new Error(`${source}: expected an object of counts`);
  }
  const counts: Record<string, number> = {};
  for (const [key, count] of Object.entries(value)) {
    if (!Number.isInteger(count) || count < 0) {
      throw new Error(`${source}: "${key}" must be a non-negative integer`);
    }
    counts[key] = count;
  }
  return counts;
}

function sortedCounts(counts: Record<string, number>): Record<string, number> {
  return Object.fromEntries(
    Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)),
  );
}

/** Serializes ceilings with sorted keys, so rewriting an unchanged file is a no-op. */
export function formatCeilings(ceilings: Ceilings): string {
  const sorted = {
    pack: ceilings.pack,
    rules: sortedCounts(ceilings.rules),
    oversizeFiles: sortedCounts(ceilings.oversizeFiles),
  };
  return `${JSON.stringify(sorted, null, 2)}\n`;
}
