import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import { put, testRepo } from "./helpers/test-repo.ts";
import { typecheckWrites } from "./typecheck-writes.ts";

function workspace(
  t: TestContext,
  typecheck: string,
  iface: Record<string, string> = {},
) {
  const root = testRepo(t);
  put(root, "pnpm-workspace.yaml", "packages:\n  - packages/*\n");
  put(
    root,
    "package.json",
    JSON.stringify({ packageManager: "pnpm@10.2.0", scripts: { typecheck } }),
  );
  put(
    root,
    "packages/iface/package.json",
    JSON.stringify({ name: "@scope/iface", scripts: iface }),
  );
  return root;
}

test("tsc --noEmit writes nothing, so a repository checking with it keeps lint beside typecheck", (t) => {
  assert.equal(typecheckWrites(workspace(t, "tsc --noEmit")), false);
});

test("a tsc whose extended tsconfig sets noEmit writes nothing, so the tsconfig chain is read and not only the command line", (t) => {
  const root = workspace(t, "tsc -p tsconfig.check.json");
  put(root, "tsconfig.base.json", '{"compilerOptions":{"noEmit":true}}');
  put(root, "tsconfig.check.json", '{"extends":"./tsconfig.base.json"}');
  assert.equal(typecheckWrites(root), false);
});

test("a plain tsc writes its output", (t) => {
  const root = workspace(t, "tsc");
  put(root, "tsconfig.json", '{"compilerOptions":{"outDir":"dist"}}');
  assert.equal(typecheckWrites(root), true);
});

test("a typecheck that runs a workspace package's build through --filter writes, so the walk follows filters into other packages", (t) => {
  const root = workspace(
    t,
    "pnpm --filter @scope/iface build && tsc --noEmit",
    {
      build: "rimraf dist && tsc",
    },
  );
  assert.equal(typecheckWrites(root), true);
});

test("a typecheck that runs a workspace package's tsc --noEmit through --filter writes nothing, so pointing at another package alone does not order lint after typecheck", (t) => {
  const root = workspace(t, "pnpm --filter @scope/iface typecheck", {
    typecheck: "tsc --noEmit",
  });
  assert.equal(typecheckWrites(root), false);
});

test("a --dir read from a variable cannot be resolved and counts as writing, so an unknown target never races lint", (t) => {
  const root = workspace(t, 'pnpm --dir "$IFACE" typecheck', {
    typecheck: "tsc --noEmit",
  });
  assert.equal(typecheckWrites(root), true);
});

test("a pretypecheck hook that builds writes, since the package manager runs it before typecheck", (t) => {
  const root = workspace(t, "tsc --noEmit");
  put(
    root,
    "package.json",
    JSON.stringify({
      scripts: {
        pretypecheck: "pnpm --filter @scope/iface build",
        typecheck: "tsc --noEmit",
      },
    }),
  );
  put(
    root,
    "packages/iface/package.json",
    JSON.stringify({ name: "@scope/iface", scripts: { build: "tsc" } }),
  );
  assert.equal(typecheckWrites(root), true);
});

test("npm reads -w after the script name, so npm run build -w <package> writes", (t) => {
  const root = workspace(t, "npm run build -w packages/iface", {
    build: "tsc",
  });
  assert.equal(typecheckWrites(root), true);
});

test("a tsc the manager runs in another package reads that package's tsconfig, not the root one", (t) => {
  const root = workspace(t, "pnpm --dir packages/iface exec tsc");
  put(root, "tsconfig.json", '{"compilerOptions":{"noEmit":true}}');
  put(root, "packages/iface/tsconfig.json", '{"compilerOptions":{}}');
  assert.equal(typecheckWrites(root), true);
});

test("a tsc after cd reads the tsconfig of the directory it moved to", (t) => {
  const root = workspace(t, "cd packages/iface && tsc");
  put(root, "tsconfig.json", '{"compilerOptions":{"noEmit":true}}');
  put(root, "packages/iface/tsconfig.json", '{"compilerOptions":{}}');
  assert.equal(typecheckWrites(root), true);
});

test("an unreadable workspace manifest counts as writing instead of failing the run", (t) => {
  const root = workspace(t, "pnpm -r typecheck");
  put(root, "packages/broken/package.json", "{\n<<<<<<< HEAD\n}");
  assert.equal(typecheckWrites(root), true);
});

test("a pnpm option that takes a separate value is not read as the script name, so pnpm -r --workspace-concurrency 1 build writes", (t) => {
  const root = workspace(t, "pnpm -r --workspace-concurrency 1 build", {
    build: "tsc",
  });
  assert.equal(typecheckWrites(root), true);
});
