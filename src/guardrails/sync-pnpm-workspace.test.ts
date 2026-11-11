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
  const root = pinnedRepo(t, "pnpm@11.0.0");
  synced(root);
  assert.deepEqual(parse(read(root, "pnpm-workspace.yaml")), {
    allowBuilds: { lefthook: false },
  });
  const check = bin(root, "sync", ["--check"]);
  assert.equal(check.status, 0, check.stdout + check.stderr);
});

test("sync keeps a repository's own pnpm-workspace.yaml settings and lefthook choice, where a sync that rewrites the file drops its packages or forces lefthook back to false", (t) => {
  const root = pinnedRepo(t, "pnpm@11.0.0");
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
  put(root, "pnpm-workspace.yaml", "allowBuilds:\n  lefthook: true\n");
  synced(root);
  assert.equal(
    read(root, "pnpm-workspace.yaml"),
    "allowBuilds:\n  lefthook: true\n",
  );
});

test("sync writes no pnpm-workspace.yaml for npm or for a pnpm before 10.5, where a sync that writes it anyway makes that pnpm fail with 'packages field missing or empty'", (t) => {
  for (const pin of ["pnpm@10.2.0+sha512.abc", "npm@11.0.0"]) {
    const root = pinnedRepo(t, pin);
    synced(root);
    assert.equal(existsSync(join(root, "pnpm-workspace.yaml")), false, pin);
  }
});
