import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { checkFrozenLockfiles } from "./frozen-lockfiles.ts";
import { bin, put, read, testRepo } from "./helpers/test-repo.ts";
import { shimInvocation } from "./run-command.ts";

/** A private package manifest with `dependencies`, which fixtures keep to `link:` ranges pnpm resolves without the registry. */
function manifest(
  name: string,
  dependencies: Record<string, string> = {},
): string {
  return JSON.stringify({ name, private: true, dependencies });
}

/** A lockfile that locks a dependency no manifest declares, so a frozen install of its folder fails. */
const STALE_LOCK =
  "lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      gone:\n        specifier: 1.0.0\n        version: 1.0.0\n";

/** Writes `folder`'s lockfile as pnpm does, alone or as the workspace its `pnpm-workspace.yaml` makes it. */
function lock(root: string, folder: string, alone: boolean): void {
  const pnpm = shimInvocation("pnpm", [
    "install",
    "--lockfile-only",
    "--ignore-scripts",
    ...(alone ? ["--ignore-workspace"] : []),
  ]);
  const result = spawnSync(pnpm.command, pnpm.args, {
    cwd: join(root, folder),
    encoding: "utf8",
    shell: pnpm.shell,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
}

/** A repository whose root workspace lists `packages/*`, with `packages/a` and a `playground` outside the workspace, each locked as pnpm installs it. */
function workspaceRepo(t: TestContext): string {
  const root = testRepo(t);
  put(root, "package.json", manifest("root"));
  put(root, "pnpm-workspace.yaml", "packages:\n  - packages/*\n");
  put(root, "packages/a/package.json", manifest("a"));
  put(root, "playground/package.json", manifest("playground"));
  lock(root, ".", false);
  lock(root, "playground", true);
  return root;
}

test("passes when every lockfile matches its manifests", async (t) => {
  const root = workspaceRepo(t);

  assert.equal(await checkFrozenLockfiles(root, undefined), "");
});

test("names a playground outside the workspace whose lockfile misses a dependency, which a run that reads the enclosing workspace passes", async (t) => {
  const root = workspaceRepo(t);
  put(
    root,
    "playground/package.json",
    manifest("playground", { a: "link:../packages/a" }),
  );

  assert.match(
    await checkFrozenLockfiles(root, undefined),
    /^playground\/pnpm-lock\.yaml is out of date with its manifests: run pnpm --dir playground install --lockfile-only and commit it\n/,
  );
});

test("names the root lockfile when a workspace member's manifest drifts from it", async (t) => {
  const root = workspaceRepo(t);
  put(root, "packages/b/package.json", manifest("b", { a: "link:../a" }));

  assert.match(
    await checkFrozenLockfiles(root, undefined),
    /^pnpm-lock\.yaml is out of date with its manifests: run pnpm --dir \. install --lockfile-only and commit it\n/,
  );
});

test("skips the lockfile of a workspace member, which pnpm never reads", async (t) => {
  const root = workspaceRepo(t);
  put(root, "packages/a/pnpm-lock.yaml", STALE_LOCK);

  assert.equal(await checkFrozenLockfiles(root, undefined), "");
});

test("checks a member holding its own pnpm-workspace.yaml as the workspace pnpm installs there", async (t) => {
  const root = workspaceRepo(t);
  put(root, "packages/sub/package.json", manifest("sub"));
  put(root, "packages/sub/pnpm-workspace.yaml", "packages: []\n");
  lock(root, "packages/sub", false);
  lock(root, ".", false);
  put(root, "packages/sub/package.json", manifest("sub", { a: "link:../a" }));

  assert.match(
    await checkFrozenLockfiles(root, undefined),
    /packages\/sub\/pnpm-lock\.yaml is out of date with its manifests/,
  );
});

test("skips the lockfile of a folder an outer workspace lists, though the nearer workspace does not, since the outer install holds it", async (t) => {
  const root = workspaceRepo(t);
  put(root, "pnpm-workspace.yaml", "packages:\n  - packages/**\n");
  put(root, "packages/sub/package.json", manifest("sub"));
  put(root, "packages/sub/pnpm-workspace.yaml", "packages: []\n");
  put(root, "packages/sub/y/package.json", manifest("y"));
  lock(root, "packages/sub", false);
  lock(root, ".", false);
  put(root, "packages/sub/y/pnpm-lock.yaml", STALE_LOCK);

  assert.equal(await checkFrozenLockfiles(root, undefined), "");
});

test("checks the lockfile of a folder a `!dir/**` pattern excludes from the workspace, which a glob that only excludes what lies below dir skips", async (t) => {
  const root = workspaceRepo(t);
  put(
    root,
    "pnpm-workspace.yaml",
    "packages:\n  - packages/*\n  - '!packages/c/**'\n",
  );
  put(root, "packages/c/package.json", manifest("c"));
  lock(root, ".", false);
  put(root, "packages/c/pnpm-lock.yaml", STALE_LOCK);

  assert.match(
    await checkFrozenLockfiles(root, undefined),
    /^packages\/c\/pnpm-lock\.yaml is out of date with its manifests/,
  );
});

test("leaves a matching lockfile byte for byte as it was, which pnpm rewrites to its own layout", async (t) => {
  const root = workspaceRepo(t);
  const path = "playground/pnpm-lock.yaml";
  put(root, path, `${read(root, path)}\n\n`);
  const before = read(root, path);

  assert.equal(await checkFrozenLockfiles(root, undefined), "");
  assert.equal(read(root, path), before);
});

test("checks runs lockfile:frozen and names its failure under the step, which a run that never schedules the step passes", (t) => {
  const root = workspaceRepo(t);
  put(
    root,
    "playground/package.json",
    manifest("playground", { a: "link:../packages/a" }),
  );

  const result = bin(root, "checks", [], {
    ANTELOPEJS_CHECKS_SKIP:
      "typecheck,lint,format:check,knip,test,size,suppressions,sync:check,lockfile:singletons,pnpm:release-age,git:identity",
  });

  assert.equal(result.status, 1, result.stdout);
  assert.match(
    result.stdout,
    /^\[lockfile:frozen\]\nplayground\/pnpm-lock\.yaml is out of date with its manifests/,
  );
});
