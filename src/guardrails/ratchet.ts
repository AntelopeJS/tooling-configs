import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  CEILINGS_FILE,
  formatCeilings,
  isRetired,
  MAX_FILE_BYTES,
  readCeilings,
  type Ceilings,
} from "./ceilings.ts";
import { authoredSizes, gitFiles } from "./files.ts";
import { lintDiagnostics, type Diagnostic } from "./oxlint.ts";
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

function changedFiles(root: string): Set<string> {
  if (
    spawnSync("git", ["rev-parse", "--verify", "HEAD"], {
      cwd: root,
      stdio: "ignore",
    }).status !== 0
  )
    return new Set(gitFiles(root));
  const tracked = execFileSync("git", ["diff", "HEAD", "--name-only", "-z"], {
    cwd: root,
    encoding: "utf8",
  });
  const untracked = execFileSync(
    "git",
    ["ls-files", "--others", "--exclude-standard", "-z"],
    { cwd: root, encoding: "utf8" },
  );
  return new Set(`${tracked}${untracked}`.split("\0").filter(Boolean));
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

export function ratchet(root: string, update = false) {
  if (!existsSync(join(root, CEILINGS_FILE)))
    throw new Error(`${CEILINGS_FILE} is missing. Run antelopejs-sync first.`);
  const ceilings = readCeilings(root);
  const diagnostics = lintDiagnostics(root);
  const current = baseline(root, diagnostics);
  const changed = changedFiles(root);
  const failures: string[] = [];
  for (const [rule, count] of Object.entries(current.rules)) {
    const limit = ceilings.rules[rule] ?? 0;
    if (count <= limit) continue;
    failures.push(`${rule}: ${count} diagnostics exceeds ceiling ${limit}.`);
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
  const lowered = update ? lowerCeilings(ceilings, current) : [];
  const retired = update && isRetired(ceilings);
  if (update) {
    const path = join(root, CEILINGS_FILE);
    if (retired) unlinkSync(path);
    else writeFileSync(path, formatCeilings(ceilings));
  }
  return { failures, lowered, retired };
}
