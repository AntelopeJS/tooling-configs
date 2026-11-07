import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { parseManifest, PREPARE_INSTALL } from "./package.ts";
import { bin, commit, put, read, testRepo } from "./helpers/test-repo.ts";

const PREVIOUS_PREPARE =
  "if git rev-parse --is-inside-work-tree >/dev/null 2>&1 && command -v lefthook >/dev/null 2>&1; then lefthook install; fi";
const HOOK_MARKER = "lefthook-installed-here";

function syncedRepo(t: Parameters<typeof testRepo>[0]): string {
  const root = testRepo(t);
  put(
    root,
    "guardrails.ratchet.json",
    '{"rules":{"eslint/no-alert":1},"oversizeFiles":{}}\n',
  );
  const result = bin(root, "sync");
  assert.equal(result.status, 0, result.stderr);
  commit(root);
  return root;
}

function preparedScript(root: string): string {
  const prepare = parseManifest(read(root, "package.json")).scripts?.prepare;
  assert.ok(prepare);
  return prepare;
}

/** A `lefthook` that records the repository whose hooks `lefthook install` would write. */
function stubLefthook(root: string): string {
  const stubs = join(root, "stub-bin");
  mkdirSync(stubs);
  put(
    root,
    "stub-bin/lefthook",
    `#!/bin/sh\ntouch "$(git rev-parse --show-toplevel)/${HOOK_MARKER}"\n`,
  );
  chmodSync(join(stubs, "lefthook"), 0o755);
  return stubs;
}

function runPrepare(prepare: string, cwd: string, stubs: string) {
  return spawnSync("/bin/sh", ["-c", prepare], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, PATH: `${stubs}:${process.env.PATH}` },
  });
}

test("a package nested in another repository's checkout leaves that repository's hooks alone", (t) => {
  const outer = syncedRepo(t);
  const prepare = preparedScript(outer);
  const stubs = stubLefthook(outer);
  const nested = join(outer, "cache", "module");
  mkdirSync(nested, { recursive: true });
  const result = runPrepare(prepare, nested, stubs);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout + result.stderr, "");
  assert.equal(existsSync(join(outer, HOOK_MARKER)), false);
  assert.equal(existsSync(join(nested, HOOK_MARKER)), false);
});

test("the project under development installs its hooks from the checkout, a linked worktree and a symlinked path", (t) => {
  const root = syncedRepo(t);
  const prepare = preparedScript(root);
  const stubs = stubLefthook(root);
  const top = runPrepare(prepare, root, stubs);
  assert.equal(top.status, 0, top.stderr);
  assert.equal(top.stdout + top.stderr, "");
  assert.equal(existsSync(join(root, HOOK_MARKER)), true);

  const worktree = join(root, "linked-worktree");
  execFileSync("git", ["worktree", "add", "-q", worktree, "-b", "linked"], {
    cwd: root,
  });
  assert.equal(existsSync(join(worktree, ".git")), true);
  assert.equal(runPrepare(prepare, worktree, stubs).status, 0);
  assert.equal(existsSync(join(worktree, HOOK_MARKER)), true);

  rmSync(join(worktree, HOOK_MARKER));
  const alias = join(root, "alias");
  symlinkSync(worktree, alias);
  assert.equal(runPrepare(prepare, alias, stubs).status, 0);
  assert.equal(existsSync(join(worktree, HOOK_MARKER)), true);
});

test("sync reports the previous prepare install as drift and rewrites it, keeping the rest of the script", (t) => {
  const root = syncedRepo(t);
  assert.equal(bin(root, "sync", ["--check"]).status, 0);
  for (const [previous, expected] of [
    [PREVIOUS_PREPARE, PREPARE_INSTALL],
    [
      `printf existing && ${PREVIOUS_PREPARE}`,
      `printf existing && ${PREPARE_INSTALL}`,
    ],
  ]) {
    const manifest = parseManifest(read(root, "package.json"));
    manifest.scripts = { ...manifest.scripts, prepare: previous };
    put(root, "package.json", `${JSON.stringify(manifest, null, 2)}\n`);
    const check = bin(root, "sync", ["--check"]);
    assert.equal(check.status, 1, check.stdout);
    assert.match(check.stdout, /^Drift: package\.json;/m);
    const sync = bin(root, "sync");
    assert.equal(sync.status, 0, sync.stderr);
    assert.equal(preparedScript(root), expected);
    assert.equal(bin(root, "sync", ["--check"]).status, 0);
  }
});
