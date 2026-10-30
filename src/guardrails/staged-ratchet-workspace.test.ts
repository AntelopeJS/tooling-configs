import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdirSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";

import { formatCeilings } from "./ceilings.ts";
import { bin, commit, linkOxlint, put, testRepo } from "./helpers/test-repo.ts";

const SOURCE =
  "export function read(text: string) {\n  const parsed = JSON.parse(text);\n  const value = parsed;\n  return value;\n}\n";

function workspaceRepo(t: TestContext, linkTypes = true) {
  const root = testRepo(t);
  linkOxlint(root);
  const require = createRequire(import.meta.url);
  const tsgolint = join(
    dirname(require.resolve("oxlint-tsgolint/package.json")),
    "bin/tsgolint.js",
  );
  mkdirSync(join(root, "node_modules/.bin"), { recursive: true });
  symlinkSync(tsgolint, join(root, "node_modules/.bin/tsgolint"));
  if (linkTypes) {
    mkdirSync(join(root, "packages/a/node_modules/@types"), {
      recursive: true,
    });
    symlinkSync(
      dirname(require.resolve("@types/node/package.json")),
      join(root, "packages/a/node_modules/@types/node"),
      "dir",
    );
  }
  put(
    root,
    ".oxlintrc.json",
    JSON.stringify({
      categories: { correctness: "off" },
      plugins: ["typescript"],
      rules: { "typescript/no-unsafe-assignment": "error" },
      options: { typeAware: true },
    }),
  );
  put(
    root,
    "tsconfig.json",
    JSON.stringify({ files: [], compilerOptions: { strict: true } }),
  );
  put(root, "packages/a/package.json", JSON.stringify({ name: "a" }));
  put(
    root,
    "packages/a/tsconfig.json",
    JSON.stringify({
      extends: "../../tsconfig.json",
      compilerOptions: { types: ["node"], noEmit: true },
      include: ["src/**/*.ts"],
    }),
  );
  put(root, "packages/a/src/index.ts", SOURCE);
  put(
    root,
    "guardrails.ratchet.json",
    formatCeilings({
      rules: { "typescript/no-unsafe-assignment": 2 },
      oversizeFiles: {},
    }),
  );
  commit(root);
  return root;
}

function stage(root: string, file: string): void {
  execFileSync("git", ["add", "--", file], { cwd: root });
}

test("staged ratchet measures a workspace package whose types resolve from its own node_modules", (t) => {
  const root = workspaceRepo(t);
  put(root, "packages/a/src/index.ts", `${SOURCE}\n`);
  stage(root, "packages/a/src/index.ts");
  const result = bin(root, "ratchet", ["--staged", "packages/a/src/index.ts"]);
  assert.equal(result.status, 0, result.stderr);
});

test("staged ratchet refuses to read a project that fails to load as zero findings", (t) => {
  const root = workspaceRepo(t, false);
  put(root, "packages/a/src/index.ts", `${SOURCE}\n`);
  stage(root, "packages/a/src/index.ts");
  const result = bin(root, "ratchet", ["--staged", "packages/a/src/index.ts"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /tsconfig/);
  assert.match(result.stderr, /Cannot find type definition file for 'node'/);
});

test("full ratchet does not reject a project that fails to load", (t) => {
  const root = workspaceRepo(t, false);
  const result = bin(root, "ratchet", []);
  assert.doesNotMatch(result.stderr, /cannot be measured/);
});
