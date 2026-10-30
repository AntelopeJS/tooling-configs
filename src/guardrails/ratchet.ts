import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  CEILINGS_FILE,
  formatCeilings,
  isRetired,
  MAX_FILE_BYTES,
  type Ceilings,
} from "./ceilings.ts";
import { adoptedRelease, newlyEnabled, recordedRelease } from "./adoption.ts";
import { authoredSizes, changedFiles } from "./files.ts";
import { lintDiagnostics, type Diagnostic } from "./oxlint.ts";
import { readCarriedCeilings } from "./renames.ts";
import { raisedRatchet } from "./ratchet-raises.ts";
import { sizeFailure } from "./size.ts";

function baseline(root: string, diagnostics: Diagnostic[]): Ceilings {
  const rules: Record<string, number> = {};
  const oversizeFiles: Record<string, number> = {};
  const sizes = authoredSizes(root);
  for (const diagnostic of diagnostics) {
    if (diagnostic.rule === "eslint/max-lines") {
      const size = sizes.get(diagnostic.file);
      if (size !== undefined) oversizeFiles[diagnostic.file] = size;
    } else rules[diagnostic.rule] = (rules[diagnostic.rule] ?? 0) + 1;
  }
  for (const [file, size] of sizes) {
    if (size > MAX_FILE_BYTES) oversizeFiles[file] = size;
  }
  return { rules, oversizeFiles };
}

export function measureBaseline(root: string, config?: string): Ceilings {
  return baseline(root, lintDiagnostics(root, config));
}

function lowerCeilings(ceilings: Ceilings, current: Ceilings): string[] {
  const lowered: string[] = [];
  for (const [rule, limit] of Object.entries(ceilings.rules)) {
    const count = current.rules[rule] ?? 0;
    if (count === 0) delete ceilings.rules[rule];
    else if (count < limit) ceilings.rules[rule] = count;
    if (count < limit) lowered.push(`${rule}: ${limit} -> ${count}`);
  }
  for (const [file, limit] of Object.entries(ceilings.oversizeFiles)) {
    if (current.oversizeFiles[file] === undefined) {
      delete ceilings.oversizeFiles[file];
      lowered.push(`${file}: removed oversize allowance`);
    } else if (current.oversizeFiles[file] < limit) {
      ceilings.oversizeFiles[file] = current.oversizeFiles[file];
      lowered.push(`${file}: ${limit} -> ${current.oversizeFiles[file]} bytes`);
    }
  }
  return lowered;
}

/** Records today's count of each rule without a ceiling that the pack enabled after `adopted`. */
function adopt(
  ceilings: Ceilings,
  current: Ceilings,
  adopted: string | undefined,
): string[] {
  const adoptions: string[] = [];
  for (const [rule, count] of Object.entries(current.rules)) {
    if (Object.hasOwn(ceilings.rules, rule)) continue;
    const since = newlyEnabled(rule, adopted);
    if (since === undefined) continue;
    ceilings.rules[rule] = count;
    adoptions.push(`${rule}: ${count}, enabled by the pack in ${since}.`);
  }
  return adoptions;
}

function adoptionHint(
  rule: string,
  ceilings: Ceilings,
  adopted: string | undefined,
): string {
  const since = Object.hasOwn(ceilings.rules, rule)
    ? undefined
    : newlyEnabled(rule, adopted);
  if (since === undefined) return "";
  const after =
    adopted === undefined ? "" : `, after this repository's ${adopted}`;
  return ` The pack enabled this rule in ${since}${after}; run ratchet:update to record today's count.`;
}

function ruleFailures(
  ceilings: Ceilings,
  current: Ceilings,
  diagnostics: Diagnostic[],
  changed: Set<string>,
  adopted: string | undefined,
): string[] {
  const failures: string[] = [];
  for (const [rule, count] of Object.entries(current.rules)) {
    const limit = ceilings.rules[rule] ?? 0;
    if (count <= limit) continue;
    failures.push(
      `${rule}: ${count} diagnostics exceeds ceiling ${limit}.${adoptionHint(rule, ceilings, adopted)}`,
    );
    const matches = diagnostics.filter(
      (diagnostic) => diagnostic.rule === rule,
    );
    const inChanged = matches.filter(({ file }) => changed.has(file));
    const shown = inChanged.length > 0 ? inChanged : matches;
    for (const diagnostic of shown)
      failures.push(`  ${diagnostic.location}: ${diagnostic.message}`);
    if (shown.length < matches.length)
      failures.push(
        `  ...and ${matches.length - shown.length} recorded in files this change does not touch.`,
      );
  }
  return failures;
}

function sizeFailures(
  root: string,
  ceilings: Ceilings,
  current: Ceilings,
): string[] {
  const failures: string[] = [];
  for (const [file, size] of Object.entries(current.oversizeFiles)) {
    const limit = ceilings.oversizeFiles[file];
    if (limit === undefined)
      failures.push(
        size > MAX_FILE_BYTES
          ? sizeFailure(file, size, MAX_FILE_BYTES)
          : `${file}: ${size} bytes and an eslint/max-lines diagnostic; this file has no oversize allowance. Split by responsibility into sibling modules, or split tests by behaviour under test, one file per describe.`,
      );
  }
  const sizes = authoredSizes(root, Object.keys(ceilings.oversizeFiles));
  for (const [file, limit] of Object.entries(ceilings.oversizeFiles)) {
    const size = sizes.get(file);
    if (size !== undefined && size > limit)
      failures.push(sizeFailure(file, size, limit));
  }
  return failures;
}

/** Writes `ceilings`, or deletes the file once no debt is left; a clean repository gets a file only when it adopted a rule. */
function persist(root: string, ceilings: Ceilings, create: boolean) {
  const path = join(root, CEILINGS_FILE);
  const present = existsSync(path);
  const retired = present && isRetired(ceilings);
  if (retired) unlinkSync(path);
  else if (present || create) writeFileSync(path, formatCeilings(ceilings));
  return { retired, created: !present && create };
}

/**
 * Fails each rule above its ceiling and each file above its allowance. With
 * `update`, first records today's count of each rule the pack enabled after
 * the repository's adopted release (creating the file in a clean
 * repository), then lowers the other ceilings and moves the recorded release
 * forward. With `pullBase`, also fails each entry added or raised against
 * that revision that is not such an adoption.
 */
export function ratchet(
  root: string,
  update = false,
  base = "HEAD",
  pullBase?: string,
) {
  if (!update && !existsSync(join(root, CEILINGS_FILE)))
    throw new Error(`${CEILINGS_FILE} is missing. Run antelopejs-sync first.`);
  const carried = readCarriedCeilings(root, false, [base]);
  const ceilings: Ceilings = { ...carried, rules: { ...carried.rules } };
  const adopted = adoptedRelease(root, ceilings.pack, pullBase ?? "HEAD");
  const diagnostics = lintDiagnostics(root);
  const current = baseline(root, diagnostics);
  const adoptions = update ? adopt(ceilings, current, adopted) : [];
  const failures = [
    ...ruleFailures(
      ceilings,
      current,
      diagnostics,
      changedFiles(root),
      adopted,
    ),
    ...sizeFailures(root, ceilings, current),
  ];
  const lowered = update ? lowerCeilings(ceilings, current) : [];
  if (update) ceilings.pack = recordedRelease(adopted);
  if (pullBase !== undefined)
    failures.push(...raisedRatchet(root, pullBase, ceilings, current));
  const { retired, created } = update
    ? persist(root, ceilings, adoptions.length > 0)
    : { retired: false, created: false };
  return { failures, lowered, adoptions, retired, created };
}
