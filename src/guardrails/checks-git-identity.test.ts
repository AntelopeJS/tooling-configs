import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { bin, put, testRepo } from "./helpers/test-repo.ts";

/** Every step backed by a package script, so only the steps `antelopejs-checks` runs itself decide the run. */
const SCRIPT_STEPS =
  "typecheck,lint,format:check,knip,test,size,suppressions,sync:check";

function checks(root: string, env: Record<string, string> = {}) {
  return bin(root, "checks", [], {
    ANTELOPEJS_CHECKS_SKIP: SCRIPT_STEPS,
    ...env,
  });
}

function setIdentity(configFile: string, key: "name" | "email", value: string) {
  appendFileSync(configFile, `[user]\n\t${key} = ${value}\n`);
}

function linkedWorktree(t: TestContext, root: string): string {
  const parent = mkdtempSync(join(tmpdir(), "antelope-guardrails-wt-"));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const worktree = join(parent, "wt");
  execFileSync("git", ["worktree", "add", "-q", worktree], { cwd: root });
  return worktree;
}

test("a user.email in the repository's .git/config fails checks and names the file and value, caught by an implementation that never reads the repository config", (t) => {
  const root = testRepo(t);
  setIdentity(join(root, ".git/config"), "email", "p@p");
  const result = checks(root);
  assert.equal(result.status, 1, result.stdout);
  assert.match(
    result.stdout,
    /^\[git:identity\]\nThe repository's git config sets a commit identity[^\n]*\n {2}file:\.git\/config user\.email p@p\n/,
  );
  assert.match(result.stdout, /Checks: 0 passed, 1 failed, 8 skipped\.\n$/);
});

test("a user.name in the shared config fails checks run from a linked worktree, caught by an implementation that reads <root>/.git/config as a file", (t) => {
  const root = testRepo(t);
  const worktree = linkedWorktree(t, root);
  setIdentity(join(root, ".git/config"), "name", "Review delegate");
  const result = checks(worktree);
  assert.equal(result.status, 1, result.stdout);
  assert.match(
    result.stdout,
    /\[git:identity\]\n[^\n]*\n {2}file:[^\n]*\.git\/config user\.name Review delegate\n/,
  );
});

test("a user.email in a worktree's config.worktree fails checks, caught by an implementation that only looks at the local scope", (t) => {
  const root = testRepo(t);
  const worktree = linkedWorktree(t, root);
  execFileSync("git", ["config", "extensions.worktreeConfig", "true"], {
    cwd: root,
  });
  const gitDir = execFileSync("git", ["rev-parse", "--absolute-git-dir"], {
    cwd: worktree,
    encoding: "utf8",
  }).trim();
  setIdentity(join(gitDir, "config.worktree"), "email", "p@p");
  const result = checks(worktree);
  assert.equal(result.status, 1, result.stdout);
  assert.match(
    result.stdout,
    /\[git:identity\]\n[^\n]*\n {2}file:[^\n]*config\.worktree user\.email p@p\n/,
  );
});

test("an identity from the global config, the command line or the environment passes, caught by an implementation that fails on any resolved identity", (t) => {
  const root = testRepo(t);
  put(root, "global.gitconfig", "[user]\n\tname = Machine\n");
  const result = checks(root, {
    GIT_CONFIG_GLOBAL: join(root, "global.gitconfig"),
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "user.email",
    GIT_CONFIG_VALUE_0: "machine@example.invalid",
  });
  assert.equal(result.status, 0, result.stdout);
  assert.equal(result.stdout, "Checks: 1 passed, 0 failed, 8 skipped.\n");
});
