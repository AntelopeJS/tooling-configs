import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { formatCeilings } from "./ceilings.ts";
import { bin, commit, linkOxlint, put, testRepo } from "./helpers/test-repo.ts";

const RULE = "typescript/no-explicit-any";
const LEGACY = "export const first: any = 1;\nexport const second: any = 2;\n";
const LEGACY_FILE = "sub/legacy.ts";

function git(root: string, ...args: string[]): void {
  execFileSync("git", args, { cwd: root });
}

function writeCeiling(root: string, count: number): void {
  put(
    root,
    "guardrails.ratchet.json",
    formatCeilings({ rules: { [RULE]: count }, oversizeFiles: {} }),
  );
}

/** HEAD holds two findings in `sub/legacy.ts` at ceiling 2; `stage` then adds `added` in new.ts under ceiling 3. */
function repo(t: TestContext) {
  const root = testRepo(t);
  linkOxlint(root);
  put(
    root,
    ".oxlintrc.json",
    JSON.stringify({
      categories: { correctness: "off" },
      plugins: ["typescript"],
      rules: { [RULE]: "error" },
    }),
  );
  put(root, LEGACY_FILE, LEGACY);
  writeCeiling(root, 2);
  commit(root);
  return root;
}

function stageRaise(root: string, added: number): void {
  put(
    root,
    "new.ts",
    Array.from(
      { length: added },
      (_, index) => `export const added${index}: any = ${index};\n`,
    ).join(""),
  );
  writeCeiling(root, 3);
  git(root, "add", "new.ts", "guardrails.ratchet.json");
}

function check(root: string) {
  return bin(root, "ratchet", ["--staged", "new.ts"], {
    APPROVED_RAISES: `${RULE}=3`,
  });
}

function assertRefused(root: string): void {
  const result = check(root);
  assert.equal(result.status, 1, result.stderr);
  assert.match(
    result.stderr,
    /holds 4 findings|skip-worktree or assume-unchanged/,
  );
  assert.doesNotMatch(result.stderr, /APPROVED RAISE ACCEPTED/);
}

const HIDES = {
  "an untracked root .eslintignore": (root) =>
    put(root, ".eslintignore", `${LEGACY_FILE}\n`),
  "a tracked file listed in .git/info/exclude": (root) =>
    appendFileSync(join(root, ".git/info/exclude"), `${LEGACY_FILE}\n`),
  "an untracked nested .gitignore": (root) =>
    put(root, "sub/.gitignore", "legacy.ts\n"),
  "an untracked nested .oxlintrc.json": (root) =>
    put(root, "sub/.oxlintrc.json", "{}"),
  "assume-unchanged on an emptied file": (root) => {
    git(root, "update-index", "--assume-unchanged", LEGACY_FILE);
    put(root, LEGACY_FILE, "export const legacy = 0;\n");
  },
  "skip-worktree on a deleted file": (root) => {
    git(root, "update-index", "--skip-worktree", LEGACY_FILE);
    rmSync(join(root, LEGACY_FILE));
  },
} satisfies Record<string, (root: string) => void>;

for (const [name, hide] of Object.entries(HIDES)) {
  test(`an approved raise holding more than N is refused with ${name}`, (t) => {
    const root = repo(t);
    stageRaise(root, 2);
    hide(root);
    assertRefused(root);
  });
}

test("an approved raise holding more than N is refused in a sparse checkout", (t) => {
  const root = repo(t);
  git(root, "sparse-checkout", "set", "--no-cone", "/*", "!/sub/");
  stageRaise(root, 2);
  assertRefused(root);
});

test("an approved raise within N is refused in a sparse checkout, which hides tracked files", (t) => {
  const root = repo(t);
  git(root, "sparse-checkout", "set", "--no-cone", "/*", "!/sub/");
  stageRaise(root, 1);
  const result = check(root);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /skip-worktree or assume-unchanged/);
});

test("an approved raise is refused while any tracked file is assume-unchanged", (t) => {
  const root = repo(t);
  put(root, "unrelated.txt", "x\n");
  commit(root);
  git(root, "update-index", "--assume-unchanged", "unrelated.txt");
  stageRaise(root, 1);
  const result = check(root);
  assert.equal(result.status, 1, result.stderr);
  assert.match(
    result.stderr,
    /skip-worktree or assume-unchanged \(unrelated\.txt\)/,
  );
});

test("an untracked file with a finding still counts toward the approved total", (t) => {
  const root = repo(t);
  stageRaise(root, 1);
  put(root, "scratch.ts", "export const scratch: any = 1;\n");
  assertRefused(root);
});

test("a variable with a non-breaking space between entries is malformed", (t) => {
  const root = repo(t);
  stageRaise(root, 1);
  const result = bin(root, "ratchet", ["--staged", "new.ts"], {
    APPROVED_RAISES: `${RULE}=3 anti-slop/no-runtime-typeof=99`,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /APPROVED_RAISES is malformed/);
});
