import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { formatCeilings } from "./ceilings.ts";
import { bin, put, testRepo } from "./helpers/test-repo.ts";

function syncedRepo(t: Parameters<typeof testRepo>[0]): string {
  const root = testRepo(t);
  put(
    root,
    "guardrails.ratchet.json",
    formatCeilings({ rules: { "eslint/max-params": 123 }, oversizeFiles: {} }),
  );
  return root;
}

function git(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" });
}

test("where git ignores the filesystem exec bit, as Git for Windows does, sync stages .agents/setup as 100755 and check reads that mode instead of reporting drift", (t) => {
  const root = syncedRepo(t);
  git(root, ["config", "core.fileMode", "false"]);
  assert.equal(bin(root, "sync").status, 0);
  assert.match(git(root, ["ls-files", "--stage", ".agents/setup"]), /^100755 /);
  chmodSync(join(root, ".agents/setup"), 0o644);
  assert.equal(bin(root, "sync", ["--check"]).status, 0);
  git(root, ["update-index", "--chmod=-x", ".agents/setup"]);
  const drift = bin(root, "sync", ["--check"]);
  assert.equal(drift.status, 1);
  assert.equal(drift.stdout, "Drift: .agents/setup; run antelopejs-sync\n");
  assert.equal(bin(root, "sync").status, 0);
  assert.match(git(root, ["ls-files", "--stage", ".agents/setup"]), /^100755 /);
});

test("the skill links sync creates read as in place on the next check, though Windows stores their / targets with \\ separators", (t) => {
  const root = syncedRepo(t);
  assert.equal(bin(root, "sync").status, 0);
  assert.ok(existsSync(join(root, ".claude/skills/unslop/SKILL.md")));
  const check = bin(root, "sync", ["--check"]);
  assert.equal(check.stdout, "Guardrails are in sync.\n");
  assert.equal(check.status, 0);
});
