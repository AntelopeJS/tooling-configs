import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import { fakeTools } from "./helpers/fake-tools.ts";
import { bareRepo } from "./helpers/init-repo.ts";
import { bin, put, read } from "./helpers/test-repo.ts";
import { parseManifest, toolingVersions } from "./package.ts";

const MEMBER_MANIFEST = {
  name: "member",
  type: "module",
  devDependencies: { "@antelopejs/tooling-configs": "^0.4.0" },
};

/** A pnpm workspace whose `member` package pins an older pack range. */
function workspaceRepo(t: TestContext): string {
  const root = bareRepo(t);
  put(root, "pnpm-workspace.yaml", "packages:\n  - member\n");
  put(
    root,
    "member/package.json",
    `${JSON.stringify(MEMBER_MANIFEST, null, 2)}\n`,
  );
  put(root, "member/src/index.ts", "export const value = 1;\n");
  return root;
}

test("--init puts a member's plain pack range on the root's catalog: spec, where an init that skips a protocol root spec leaves the member on its own range and installs the pack twice", (t) => {
  const root = workspaceRepo(t);
  const tools = fakeTools(t);
  put(
    root,
    "pnpm-workspace.yaml",
    'packages:\n  - member\ncatalog:\n  "@antelopejs/tooling-configs": ^0.5.0\n',
  );
  put(
    root,
    "package.json",
    `${JSON.stringify({ name: "onboarded", type: "module", packageManager: "pnpm@10.20.0", devDependencies: { "@antelopejs/tooling-configs": "catalog:" } }, null, 2)}\n`,
  );
  const result = bin(root, "sync", ["--init"], tools.env);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.equal(
    parseManifest(read(root, "member/package.json")).devDependencies?.[
      "@antelopejs/tooling-configs"
    ],
    "catalog:",
  );
});

test("--init puts a member's plain pack range on the root's catalog: spec when the catalog entry is a YAML alias, where an init that reads only scalar entries leaves the member on its own range", (t) => {
  const root = workspaceRepo(t);
  const tools = fakeTools(t);
  put(
    root,
    "pnpm-workspace.yaml",
    'packages:\n  - member\npack: &pack ^0.5.0\ncatalog:\n  "@antelopejs/tooling-configs": *pack\n',
  );
  put(
    root,
    "package.json",
    `${JSON.stringify({ name: "onboarded", type: "module", packageManager: "pnpm@10.20.0", devDependencies: { "@antelopejs/tooling-configs": "catalog:" } }, null, 2)}\n`,
  );
  const result = bin(root, "sync", ["--init"], tools.env);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.equal(
    parseManifest(read(root, "member/package.json")).devDependencies?.[
      "@antelopejs/tooling-configs"
    ],
    "catalog:",
  );
});

test("--init stops before installing when a member's catalog: pack spec resolves to another range than the root's, where an init that skips every protocol member spec installs the pack twice and exits 0", (t) => {
  const root = workspaceRepo(t);
  const tools = fakeTools(t);
  put(
    root,
    "pnpm-workspace.yaml",
    'packages:\n  - member\ncatalogs:\n  legacy:\n    "@antelopejs/tooling-configs": ^0.4.0\n',
  );
  put(
    root,
    "member/package.json",
    `${JSON.stringify({ ...MEMBER_MANIFEST, devDependencies: { ...MEMBER_MANIFEST.devDependencies, "@antelopejs/tooling-configs": "catalog:legacy" } }, null, 2)}\n`,
  );
  const result = bin(root, "sync", ["--init"], tools.env);
  assert.equal(result.status, 1, result.stdout);
  assert.match(
    result.stderr,
    /member\/package\.json.*@antelopejs\/tooling-configs.*catalog:legacy/,
  );
  assert.deepEqual(tools.installs(), []);
});

test("--init keeps a member's catalog: pack spec that resolves to the root's range, where an init that compares specs as written fails a workspace that installs one copy", (t) => {
  const root = workspaceRepo(t);
  const tools = fakeTools(t);
  put(
    root,
    "pnpm-workspace.yaml",
    `packages:\n  - member\ncatalog:\n  "@antelopejs/tooling-configs": "^${toolingVersions().pack}"\n`,
  );
  put(
    root,
    "member/package.json",
    `${JSON.stringify({ ...MEMBER_MANIFEST, devDependencies: { ...MEMBER_MANIFEST.devDependencies, "@antelopejs/tooling-configs": "catalog:" } }, null, 2)}\n`,
  );
  const result = bin(root, "sync", ["--init"], tools.env);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.equal(
    parseManifest(read(root, "member/package.json")).devDependencies?.[
      "@antelopejs/tooling-configs"
    ],
    "catalog:",
  );
});
