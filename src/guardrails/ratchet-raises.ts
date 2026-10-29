import { spawnSync } from "node:child_process";

import { adoptedRelease, compareReleases, newlyEnabled } from "./adoption.ts";
import { CEILINGS_FILE, parseCeilings, type Ceilings } from "./ceilings.ts";
import { renamedPaths } from "./renames.ts";
import { SUPPRESSIONS_FILE } from "./suppression-budget.ts";

function committed(root: string, revision: string, path: string) {
  const result = spawnSync("git", ["show", `${revision}:${path}`], {
    cwd: root,
    encoding: "utf8",
  });
  return result.status === 0 ? result.stdout : undefined;
}

function packFailure(base: Ceilings, ceilings: Ceilings): string[] {
  if (base.pack === undefined) return [];
  if (ceilings.pack === undefined)
    return [
      `${CEILINGS_FILE}: drops the recorded pack release ${base.pack} the base has.`,
    ];
  return compareReleases(ceilings.pack, base.pack) < 0
    ? [
        `${CEILINGS_FILE}: lowers the recorded pack release from ${base.pack} on the base to ${ceilings.pack}.`,
      ]
    : [];
}

function ruleFailures(
  base: Ceilings,
  ceilings: Ceilings,
  measured: Ceilings,
  adopted: string | undefined,
): string[] {
  const failures: string[] = [];
  for (const [rule, limit] of Object.entries(ceilings.rules)) {
    const before = base.rules[rule];
    const count = measured.rules[rule] ?? 0;
    if (before !== undefined) {
      if (limit > before)
        failures.push(
          `${CEILINGS_FILE}: raises ${rule} from ${before} on the base to ${limit}.`,
        );
    } else if (newlyEnabled(rule, adopted) === undefined)
      failures.push(
        `${CEILINGS_FILE}: adds ${rule}, which the pack did not newly enable.`,
      );
    else if (limit > count)
      failures.push(
        `${CEILINGS_FILE}: adds ${rule} at ${limit}, above its ${count} findings.`,
      );
  }
  return failures;
}

function oversizeFailures(
  base: Ceilings,
  ceilings: Ceilings,
  renames: Map<string, string>,
): string[] {
  const failures: string[] = [];
  for (const [file, limit] of Object.entries(ceilings.oversizeFiles)) {
    const before =
      base.oversizeFiles[file] ?? base.oversizeFiles[renames.get(file) ?? file];
    if (before === undefined)
      failures.push(
        `${CEILINGS_FILE}: adds an oversize allowance for ${file}.`,
      );
    else if (limit > before)
      failures.push(
        `${CEILINGS_FILE}: raises the oversize allowance of ${file} from ${before} bytes on the base to ${limit}.`,
      );
  }
  return failures;
}

/**
 * Fails each ceiling of `ceilings` added or raised against the ratchet file
 * at `revision`, except a rule the pack enabled after the base's adopted
 * release, recorded at no more than its `measured` count; and a recorded pack
 * release dropped or lowered. Renamed files keep their allowance. A base with
 * neither a ratchet file nor a suppression budget, a first adoption, passes.
 */
export function raisedRatchet(
  root: string,
  revision: string,
  ceilings: Ceilings,
  measured: Ceilings,
): string[] {
  const text = committed(root, revision, CEILINGS_FILE);
  if (
    text === undefined &&
    committed(root, revision, SUPPRESSIONS_FILE) === undefined
  )
    return [];
  const base =
    text === undefined
      ? { rules: {}, oversizeFiles: {} }
      : parseCeilings(text, `${revision.slice(0, 12)}:${CEILINGS_FILE}`);
  const failures = [
    ...packFailure(base, ceilings),
    ...ruleFailures(
      base,
      ceilings,
      measured,
      adoptedRelease(root, base.pack, revision),
    ),
    ...oversizeFailures(base, ceilings, renamedPaths(root, false, [revision])),
  ];
  return failures.length
    ? [
        ...failures,
        "Ceilings only go down: ratchet:update lowers them and records only the rules the pack newly enabled. Fix the code; raising a ceiling needs the operator's approval through the ruleset bypass.",
      ]
    : [];
}
