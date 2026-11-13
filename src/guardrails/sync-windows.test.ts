import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, rmSync, statSync, symlinkSync } from "node:fs";
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

test("where git ignores the filesystem exec bit, check reads .agents/setup's mode from the index; sync stages 100755 only where the filesystem drops the bit, as on Windows, and leaves the index alone elsewhere", (t) => {
  const root = syncedRepo(t);
  git(root, ["config", "core.fileMode", "false"]);
  assert.equal(bin(root, "sync").status, 0);
  git(root, ["add", ".agents/setup"]);
  git(root, ["update-index", "--chmod=+x", ".agents/setup"]);
  chmodSync(join(root, ".agents/setup"), 0o755);
  const dropsExecBit =
    (statSync(join(root, ".agents/setup")).mode & 0o111) === 0;
  chmodSync(join(root, ".agents/setup"), 0o644);
  assert.equal(bin(root, "sync", ["--check"]).status, 0);
  git(root, ["update-index", "--chmod=-x", ".agents/setup"]);
  if (!dropsExecBit) chmodSync(join(root, ".agents/setup"), 0o644);
  const drift = bin(root, "sync", ["--check"]);
  assert.equal(drift.status, 1);
  assert.equal(drift.stdout, "Drift: .agents/setup; run antelopejs-sync\n");
  assert.equal(bin(root, "sync").status, 0);
  assert.match(
    git(root, ["ls-files", "--stage", ".agents/setup"]),
    dropsExecBit ? /^100755 / : /^100644 /,
  );
  assert.equal(bin(root, "sync", ["--check"]).status, 0);
});

test("a skill link holding an absolute target is drift, since it resolves only on the machine that made it", (t) => {
  const root = syncedRepo(t);
  assert.equal(bin(root, "sync").status, 0);
  const link = join(root, ".claude/skills/unslop");
  rmSync(link);
  symlinkSync(join(root, ".agents/skills/unslop"), link, "dir");
  const check = bin(root, "sync", ["--check"]);
  assert.equal(
    check.stdout,
    "Drift: .claude/skills/unslop; run antelopejs-sync\n",
  );
  assert.equal(check.status, 1);
});

test("the skill links sync creates read as in place on the next check, though Windows stores their / targets with \\ separators", (t) => {
  const root = syncedRepo(t);
  assert.equal(bin(root, "sync").status, 0);
  assert.ok(existsSync(join(root, ".claude/skills/unslop/SKILL.md")));
  const check = bin(root, "sync", ["--check"]);
  assert.equal(check.stdout, "Guardrails are in sync.\n");
  assert.equal(check.status, 0);
});
