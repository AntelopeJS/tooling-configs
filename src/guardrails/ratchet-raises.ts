import { spawnSync } from "node:child_process";

import {
  adoptedRelease,
  agentFilesPending,
  compareReleases,
  newlyEnabled,
  PACK_NEW_RULES,
} from "./adoption.ts";
import { CEILINGS_FILE, parseCeilings, type Ceilings } from "./ceilings.ts";
import { isAgentFile } from "./files.ts";
import { renamedPaths } from "./renames.ts";
import { SUPPRESSIONS_FILE } from "./suppression-budget.ts";

function committed(root: string, revision: string, path: string) {
  const result = spawnSync("git", ["show", `${revision}:${path}`], {
    cwd: root,
    encoding: "utf8",
  });
  return result.status === 0 ? result.stdout : undefined;
}

function committedSize(
  root: string,
  revision: string,
  path: string,
): number | undefined {
  const result = spawnSync("git", ["cat-file", "-s", `${revision}:${path}`], {
    cwd: root,
    encoding: "utf8",
  });
  return result.status === 0 ? Number(result.stdout) : undefined;
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

function notNewlyEnabled(rule: string, adopted: string | undefined): string {
  const since = PACK_NEW_RULES.get(rule);
  return since === undefined
    ? `${CEILINGS_FILE}: adds ${rule}, which the pack did not newly enable.`
    : `${CEILINGS_FILE}: adds ${rule}, which the pack enabled in ${since}, not after this repository's ${adopted ?? since}.`;
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
      failures.push(notNewlyEnabled(rule, adopted));
    else if (limit > count)
      failures.push(
        `${CEILINGS_FILE}: adds ${rule} at ${limit}, above its ${count} findings.`,
      );
  }
  return failures;
}

/** The base revision an oversize allowance is judged against. */
interface OversizeBase {
  root: string;
  revision: string;
  renames: Map<string, string>;
  adopted: string | undefined;
}

function oversizeFailures(
  { root, revision, renames, adopted }: OversizeBase,
  base: Ceilings,
  ceilings: Ceilings,
  measured: Ceilings,
): string[] {
  const failures: string[] = [];
  for (const [file, limit] of Object.entries(ceilings.oversizeFiles)) {
    const before =
      base.oversizeFiles[file] ?? base.oversizeFiles[renames.get(file) ?? file];
    if (before === undefined) {
      const adoptable = isAgentFile(file) && agentFilesPending(adopted);
      const existing = adoptable
        ? committedSize(root, revision, renames.get(file) ?? file)
        : undefined;
      if (existing === undefined)
        failures.push(
          `${CEILINGS_FILE}: adds an oversize allowance for ${file}.`,
        );
      else if (limit > Math.min(existing, measured.oversizeFiles[file] ?? 0))
        failures.push(
          `${CEILINGS_FILE}: raises the oversize allowance of ${file} from ${existing} bytes on the base to ${limit}.`,
        );
    } else if (limit > before)
      failures.push(
        `${CEILINGS_FILE}: raises the oversize allowance of ${file} from ${before} bytes on the base to ${limit}.`,
      );
  }
  return failures;
}

/**
 * Fails each ceiling of `ceilings` added or raised against the ratchet file
 * at `revision`, except a rule the pack enabled after the base's adopted
 * release, recorded at no more than its `measured` count, and an oversize
 * agent file that exists at the base, allowed at no more than its size there
 * and its measured size, while the base predates counting those files; and a recorded pack
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
  const adopted = adoptedRelease(root, base.pack, revision);
  const failures = [
    ...packFailure(base, ceilings),
    ...ruleFailures(base, ceilings, measured, adopted),
    ...oversizeFailures(
      {
        root,
        revision,
        renames: renamedPaths(root, false, [revision]),
        adopted,
      },
      base,
      ceilings,
      measured,
    ),
  ];
  return failures.length
    ? [
        ...failures,
        "Ceilings only go down: ratchet:update lowers them and records only the rules the pack newly enabled. Fix the code; raising a ceiling needs the operator's approval through the ruleset bypass.",
      ]
    : [];
}
