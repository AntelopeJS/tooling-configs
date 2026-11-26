import assert from "node:assert/strict";
import test from "node:test";

import type { Manifest } from "./package.ts";
import { syncRepository } from "./sync.ts";
import { put, read, testRepo } from "./helpers/test-repo.ts";

function manifest(fields: Manifest): string {
  return `${JSON.stringify(fields, null, 2)}\n`;
}

function repo(
  t: Parameters<typeof testRepo>[0],
  spec: string,
  sibling: string,
) {
  const root = testRepo(t, false);
  put(
    root,
    "package.json",
    manifest({
      name: "fixture",
      private: true,
      packageManager: "pnpm@10.33.0",
    }),
  );
  put(root, "pnpm-workspace.yaml", 'packages:\n  - "packages/*"\n');
  put(
    root,
    "pnpm-lock.yaml",
    "lockfileVersion: '9.0'\n\nimporters:\n\n  .: {}\n",
  );
  put(
    root,
    "packages/a/package.json",
    manifest({
      name: "@antelopejs/a",
      version: "1.0.0",
      dependencies: { [sibling]: spec },
    }),
  );
  put(root, "packages/a/README.md", "# A\n");
  put(
    root,
    "packages/b/package.json",
    manifest({ name: "@antelopejs/b", version: "0.4.1" }),
  );
  return root;
}

for (const [spec, shown] of [
  ["workspace:^", "^0.4.1"],
  ["workspace:~", "~0.4.1"],
  ["workspace:*", "0.4.1"],
  ["workspace:^0.3.0", "^0.3.0"],
] as const)
  test(`the Supported cell shows the range pnpm pack writes for ${spec}`, (t) => {
    const root = repo(t, spec, "@antelopejs/b");
    assert.deepEqual(syncRepository(root).errors, []);
    assert.ok(read(root, "packages/a/README.md").includes(`| \`${shown}\``));
    assert.deepEqual(
      syncRepository(root, { check: true }).paths.filter((path) =>
        path.endsWith("README.md"),
      ),
      [],
    );
  });

test("a workspace spec naming no workspace package fails instead of publishing workspace:^", (t) => {
  const root = repo(t, "workspace:^", "@antelopejs/ghost");
  assert.match(syncRepository(root).errors.join("\n"), /ghost@workspace:\^/);
});
