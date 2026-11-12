import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { TestContext } from "node:test";
import test from "node:test";

import { parse } from "yaml";

import { parseManifest } from "./package.ts";
import { bin, put, read, testRepo } from "./helpers/test-repo.ts";

function pinnedRepo(t: TestContext, packageManager: string): string {
  const root = testRepo(t);
  const manifest = parseManifest(read(root, "package.json"));
  put(
    root,
    "package.json",
    `${JSON.stringify({ ...manifest, packageManager }, null, 2)}\n`,
  );
  put(
    root,
    "guardrails.ratchet.json",
    '{"rules":{"eslint/no-alert":1},"oversizeFiles":{}}\n',
  );
  return root;
}

function synced(root: string): void {
  const result = bin(root, "sync");
  assert.equal(result.status, 0, result.stderr + result.stdout);
}

test("sync tells pnpm 11 not to build lefthook and then reports no drift, where a sync that writes no allowBuilds leaves every install failing with ERR_PNPM_IGNORED_BUILDS", (t) => {
  const root = pinnedRepo(t, "pnpm@11.27.1");
  synced(root);
  assert.deepEqual(parse(read(root, "pnpm-workspace.yaml")), {
    allowBuilds: { lefthook: false },
  });
  const check = bin(root, "sync", ["--check"]);
  assert.equal(check.status, 0, check.stdout + check.stderr);
});

test("sync keeps a repository's own pnpm-workspace.yaml settings and leaves a file that decides lefthook byte for byte, where a sync that rewrites it drops its packages, forces lefthook back to false or fights oxfmt over its formatting", (t) => {
  const root = pinnedRepo(t, "pnpm@11.27.1");
  put(
    root,
    "pnpm-workspace.yaml",
    "packages:\n  - packages/*\nallowBuilds:\n  esbuild: true\n",
  );
  synced(root);
  assert.deepEqual(parse(read(root, "pnpm-workspace.yaml")), {
    packages: ["packages/*"],
    allowBuilds: { esbuild: true, lefthook: false },
  });
  const decided =
    'packages: ["packages/*"]\nallowBuilds:\n    lefthook: true\n';
  put(root, "pnpm-workspace.yaml", decided);
  synced(root);
  assert.equal(read(root, "pnpm-workspace.yaml"), decided);
});

test("sync tells pnpm 11 not to build the capture peer mongodb-memory-server in a repository with docs/captures.ts and keeps each build the repository already decides, where a sync that decides lefthook alone or overwrites a decided build leaves that install failing with ERR_PNPM_IGNORED_BUILDS", (t) => {
  const root = pinnedRepo(t, "pnpm@11.27.1");
  put(root, "docs/captures.ts", "export default [];\n");
  synced(root);
  assert.deepEqual(parse(read(root, "pnpm-workspace.yaml")), {
    allowBuilds: { lefthook: false, "mongodb-memory-server": false },
  });
  const check = bin(root, "sync", ["--check"]);
  assert.equal(check.status, 0, check.stdout + check.stderr);
  const decided =
    "allowBuilds:\n  lefthook: false\n  mongodb-memory-server: true\n";
  put(root, "pnpm-workspace.yaml", decided);
  synced(root);
  assert.equal(read(root, "pnpm-workspace.yaml"), decided);
  put(root, "pnpm-workspace.yaml", "allowBuilds:\n  lefthook: true\n");
  synced(root);
  assert.deepEqual(parse(read(root, "pnpm-workspace.yaml")), {
    allowBuilds: { lefthook: true, "mongodb-memory-server": false },
  });
});

for (const [current, written] of [
  ["---\n", "---\nallowBuilds:\n  lefthook: false\n"],
  ["\n\n# settings\n", "# settings\nallowBuilds:\n  lefthook: false\n"],
  [
    'packages: ["a"]\nallowBuilds: {}\n',
    'packages: ["a"]\nallowBuilds:\n  lefthook: false\n',
  ],
  ["allowBuilds:\n  lefthook:\n", "allowBuilds:\n  lefthook: false\n"],
])
  test(`sync writes ${JSON.stringify(current)} as oxfmt leaves it, where a sync that pads flow maps, keeps leading blank lines, rejects a bare document marker or counts a null lefthook as decided fails format:check or the install`, (t) => {
    const root = pinnedRepo(t, "pnpm@11.27.1");
    put(root, "pnpm-workspace.yaml", current);
    synced(root);
    assert.equal(read(root, "pnpm-workspace.yaml"), written);
  });

for (const current of ["", "# workspace settings\n", "allowBuilds:\n"])
  test(`sync completes a pnpm-workspace.yaml that pnpm accepts as ${JSON.stringify(current)}, where a sync that demands a mapping exits 1 on it`, (t) => {
    const root = pinnedRepo(t, "pnpm@11.27.1");
    put(root, "pnpm-workspace.yaml", current);
    synced(root);
    assert.deepEqual(parse(read(root, "pnpm-workspace.yaml")), {
      allowBuilds: { lefthook: false },
    });
  });

for (const pin of ["pnpm@10.2.0+sha512.abc", "pnpm@10.33.0", "npm@11.0.0"])
  test(`sync writes no pnpm-workspace.yaml for ${pin}, where a sync that writes it anyway makes pnpm 10 install a nested project such as playground into the repository root, pnpm before 10.5 fail with 'packages field missing or empty', or leaves an npm repository a stray file`, (t) => {
    const root = pinnedRepo(t, pin);
    synced(root);
    assert.equal(existsSync(join(root, "pnpm-workspace.yaml")), false);
  });

for (const current of [
  "allowBuilds:\n  lefthook: false\n  mongodb-memory-server: false\n",
  "",
  "# settings\n",
])
  test(`sync asks a pnpm 10 repository to delete a pnpm-workspace.yaml written as ${JSON.stringify(current)} and leaves it as it is, where a sync that keeps it silently keeps nested installs going to the root and a sync that completes it fails its own next check`, (t) => {
    const root = pinnedRepo(t, "pnpm@10.6.5");
    put(root, "pnpm-workspace.yaml", current);
    const result = bin(root, "sync");
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout + result.stderr, /Delete pnpm-workspace\.yaml/);
    assert.equal(read(root, "pnpm-workspace.yaml"), current);
  });

test("sync keeps a pnpm 10 repository's pnpm-workspace.yaml that holds its own settings, where a sync that asks to delete it drops the repository's overrides", (t) => {
  const root = pinnedRepo(t, "pnpm@10.6.5");
  const own = "overrides:\n  foo: 1.0.0\nallowBuilds:\n  lefthook: false\n";
  put(root, "pnpm-workspace.yaml", own);
  synced(root);
  assert.equal(read(root, "pnpm-workspace.yaml"), own);
});

for (const current of [undefined, "allowBuilds:\n  lefthook: false\n"])
  test(`sync asks a repository that pins pnpm 11 before 11.27.1 to raise its pin when its pnpm-workspace.yaml is ${JSON.stringify(current ?? "absent")}, where a sync that writes or keeps that file makes that pnpm install a nested project into the repository root and a sync that skips it leaves the install failing with ERR_PNPM_IGNORED_BUILDS`, (t) => {
    const root = pinnedRepo(t, "pnpm@11.27.0");
    if (current !== undefined) put(root, "pnpm-workspace.yaml", current);
    const result = bin(root, "sync", ["--check"]);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout + result.stderr, /pnpm@11\.27\.1/);
    assert.equal(
      existsSync(join(root, "pnpm-workspace.yaml")),
      current !== undefined,
    );
  });
