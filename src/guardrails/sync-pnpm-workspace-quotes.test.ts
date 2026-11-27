import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import { parseManifest } from "./package.ts";
import { bin, put, read, testRepo } from "./helpers/test-repo.ts";

const NESTED = "frontend-vue";
const NESTED_WORKSPACE = `${NESTED}/pnpm-workspace.yaml`;

function nestedRepo(t: TestContext): string {
  const root = testRepo(t);
  const manifest = parseManifest(read(root, "package.json"));
  put(
    root,
    "package.json",
    `${JSON.stringify({ ...manifest, packageManager: "pnpm@11.27.1" }, null, 2)}\n`,
  );
  put(root, `${NESTED}/pnpm-lock.yaml`, "lockfileVersion: '9.0'\n");
  return root;
}

function synced(root: string): void {
  const result = bin(root, "sync");
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const check = bin(root, "sync", ["--check"]);
  assert.equal(check.status, 0, check.stdout + check.stderr);
}

test("sync writes a nested pnpm-workspace.yaml in single quotes under a .prettierrc that sets singleQuote, where a sync that always writes double quotes fails the folder's prettier --check", (t) => {
  const root = nestedRepo(t);
  put(
    root,
    `${NESTED}/.prettierrc`,
    '{ "singleQuote": true, "useTabs": true }\n',
  );
  synced(root);
  assert.equal(
    read(root, NESTED_WORKSPACE),
    "packages:\n  - '.'\nminimumReleaseAge: 1440\nminimumReleaseAgeExclude:\n  - '@antelopejs/*'\n",
  );
});

test("sync adds the interface pattern in single quotes to a nested list under a package.json prettier key that sets singleQuote, where a sync that reads only .prettierrc adds it in double quotes", (t) => {
  const root = nestedRepo(t);
  put(
    root,
    `${NESTED}/package.json`,
    '{ "private": true, "prettier": { "singleQuote": true } }\n',
  );
  put(
    root,
    NESTED_WORKSPACE,
    "packages:\n  - '.'\nminimumReleaseAge: 1440\nminimumReleaseAgeExclude:\n  - '@antelopejs/dms@0.20.0'\n",
  );
  synced(root);
  assert.equal(
    read(root, NESTED_WORKSPACE),
    "packages:\n  - '.'\nminimumReleaseAge: 1440\nminimumReleaseAgeExclude:\n  - '@antelopejs/dms@0.20.0'\n  - '@antelopejs/*'\n",
  );
});

test("sync keeps double quotes in a nested pnpm-workspace.yaml under a .prettierrc that sets singleQuote false, where a sync that always writes single quotes fails that folder's prettier --check", (t) => {
  const root = nestedRepo(t);
  put(root, `${NESTED}/.prettierrc`, '{ "singleQuote": false }\n');
  synced(root);
  assert.equal(
    read(root, NESTED_WORKSPACE),
    'packages:\n  - "."\nminimumReleaseAge: 1440\nminimumReleaseAgeExclude:\n  - "@antelopejs/*"\n',
  );
});
