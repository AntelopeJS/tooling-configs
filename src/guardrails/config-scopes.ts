import { matchesGlob } from "node:path";

/** Scopes that name every file: a block without `files`, and the globstar forms. */
const EVERY_FILE = new Set(["*", "**", "**/*"]);

/** Glob syntax beyond `*` and `**`, compared only for equality. */
const OTHER_SYNTAX = /[?[\]{}()!+@]/u;

/** A glob with syntax beyond `*` and `**`, or a `.` or `..` segment, which ESLint resolves and oxlint does not. */
function unsupported(glob: string): boolean {
  return (
    OTHER_SYNTAX.test(glob) ||
    segmentsOf(glob).some((segment) => segment === "." || segment === "..")
  );
}

/** The rule and glob of a config budget key, `<rule> for <glob>`. */
function keyParts(key: string): { rule: string; glob: string } | undefined {
  const at = key.indexOf(" for ");
  return at < 0
    ? undefined
    : { rule: key.slice(0, at), glob: key.slice(at + " for ".length) };
}

function segmentsOf(glob: string): string[] {
  return glob
    .replace(/^\.\//u, "")
    .replace(/\/+$/u, "")
    .split("/")
    .filter(Boolean);
}

/** Whether one path segment pattern names every name `narrow` names: `narrow` read literally must match `wide`, and a wildcard-free `wide` must equal it. */
function segmentContains(wide: string, narrow: string): boolean {
  if (wide === narrow || wide === "*") return true;
  if (!wide.includes("*")) return false;
  return matchesGlob(narrow, wide);
}

function segmentsContain(
  wide: string[],
  narrow: string[],
  from = 0,
  at = 0,
): boolean {
  if (from === wide.length) return at === narrow.length;
  if (wide[from] === "**") {
    for (let next = at; next <= narrow.length; next++)
      if (segmentsContain(wide, narrow, from + 1, next)) return true;
    return false;
  }
  if (at === narrow.length || narrow[at] === "**") return false;
  return (
    segmentContains(wide[from], narrow[at]) &&
    segmentsContain(wide, narrow, from + 1, at + 1)
  );
}

/**
 * Whether glob `wide` names every file `narrow` names, decided
 * conservatively: `*`, `**` and `**\/*` name every file; otherwise segment by
 * segment, where only `**` in `wide` covers `**` in `narrow`, a single-segment
 * `*` never does, and other glob syntax or a `.` or `..` segment must match
 * exactly.
 */
export function globContains(wide: string, narrow: string): boolean {
  if (EVERY_FILE.has(wide) || wide === narrow) return true;
  if (EVERY_FILE.has(narrow)) return false;
  if ([wide, narrow].some(unsupported)) return false;
  return segmentsContain(segmentsOf(wide), segmentsOf(narrow));
}

/**
 * Config ceilings with the room a scope gives up lent to the narrower scopes
 * of the same rule: a key over its limit may also use the largest amount any
 * same-rule key whose glob contains its glob sits below its own limit. A
 * narrowed or split scope therefore passes, and a widened or moved one does
 * not.
 */
export function coveredLimits(
  limits: Record<string, number>,
  counts: Record<string, number>,
) {
  const covered = { ...limits };
  for (const [key, count] of Object.entries(counts)) {
    const limit = limits[key] ?? 0;
    const narrow = keyParts(key);
    if (count <= limit || narrow === undefined) continue;
    let room = 0;
    for (const [wideKey, wideLimit] of Object.entries(limits)) {
      const wide = keyParts(wideKey);
      if (
        wideKey !== key &&
        wide?.rule === narrow.rule &&
        globContains(wide.glob, narrow.glob)
      )
        room = Math.max(room, wideLimit - (counts[wideKey] ?? 0));
    }
    covered[key] = limit + room;
  }
  return covered;
}
