import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { parse } from "yaml";

import { parseManifest } from "./package.ts";
import { bin, put, read, testRepo } from "./helpers/test-repo.ts";

const TEMPLATE = ["--profile", "template"];
const FRESH_INTERFACES = {
  minimumReleaseAgeExclude: ["@antelopejs/interface-*"],
};
const PLAYGROUND_LOCK = "playground/pnpm-lock.yaml";
const PLAYGROUND_WORKSPACE = "playground/pnpm-workspace.yaml";

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

function withPlayground(root: string): void {
  put(root, "playground/package.json", '{ "private": true }\n');
  put(root, PLAYGROUND_LOCK, "lockfileVersion: '9.0'\n");
}

function synced(root: string, args: string[] = []): void {
  const result = bin(root, "sync", args);
  assert.equal(result.status, 0, result.stderr + result.stdout);
}

test("sync lists the interface pattern in the pnpm-workspace.yaml of a nested folder with its own pnpm-lock.yaml, then reports no drift, where a sync that writes only the root file leaves pnpm 11 installing that folder as its own workspace without the exclusion and locking two copies of an interface released less than a day ago", (t) => {
  const root = pinnedRepo(t, "pnpm@11.27.1");
  withPlayground(root);
  synced(root);
  assert.deepEqual(parse(read(root, PLAYGROUND_WORKSPACE)), FRESH_INTERFACES);
  const check = bin(root, "sync", ["--check"]);
  assert.equal(check.status, 0, check.stdout + check.stderr);
});

test("sync lists the interface pattern in the pnpm-workspace.yaml of a playground that has no lockfile yet, then reports no drift, where a sync that keys on lockfiles alone lets its first pnpm 11 install lock two copies of an interface released less than a day ago", (t) => {
  const root = pinnedRepo(t, "pnpm@11.27.1");
  put(root, "playground/package.json", '{ "private": true }\n');
  synced(root);
  assert.deepEqual(parse(read(root, PLAYGROUND_WORKSPACE)), FRESH_INTERFACES);
  const check = bin(root, "sync", ["--check"]);
  assert.equal(check.status, 0, check.stdout + check.stderr);
});

test("sync lists the interface pattern in a playground's pnpm-workspace.yaml in one run under an empty root pnpm-workspace.yaml, where a sync that reads an empty file as a workspace that may list the playground needs a second run", (t) => {
  const root = pinnedRepo(t, "pnpm@11.27.1");
  put(root, "pnpm-workspace.yaml", "");
  put(root, "playground/package.json", '{ "private": true }\n');
  synced(root);
  const check = bin(root, "sync", ["--check"]);
  assert.equal(check.status, 0, check.stdout + check.stderr);
});

test("sync writes no pnpm-workspace.yaml in a playground the root workspace lists, where a sync that writes one makes it a workspace of its own that loses the root's workspace packages", (t) => {
  const root = pinnedRepo(t, "pnpm@11.27.1");
  put(root, "pnpm-workspace.yaml", "packages:\n  - playground\n");
  put(root, "playground/package.json", '{ "private": true }\n');
  synced(root);
  assert.equal(existsSync(join(root, PLAYGROUND_WORKSPACE)), false);
});

test("sync adds the interface pattern to the pnpm-workspace.yaml pnpm 11 wrote in a nested folder and keeps its entries, where a sync that replaces the file drops the packages pnpm excluded for that install", (t) => {
  const root = pinnedRepo(t, "pnpm@11.27.1");
  withPlayground(root);
  put(
    root,
    PLAYGROUND_WORKSPACE,
    "minimumReleaseAgeExclude:\n  - '@antelopejs/dms@0.20.0'\n",
  );
  synced(root);
  assert.deepEqual(parse(read(root, PLAYGROUND_WORKSPACE)), {
    minimumReleaseAgeExclude: [
      "@antelopejs/dms@0.20.0",
      "@antelopejs/interface-*",
    ],
  });
});

test("sync writes no pnpm-workspace.yaml in a nested folder of a pnpm 10 repository, where a sync that writes it leaves a stray file pnpm 10 has no release age for", (t) => {
  const root = pinnedRepo(t, "pnpm@10.6.5");
  withPlayground(root);
  synced(root);
  assert.equal(existsSync(join(root, PLAYGROUND_WORKSPACE)), false);
});

test("sync keeps the builds it declares in the root pnpm-workspace.yaml of a repository with a root pnpm-lock.yaml and a nested one, where a sync that also plans the root as a nested folder overwrites them with the interface pattern alone", (t) => {
  const root = pinnedRepo(t, "pnpm@11.27.1");
  put(root, "pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
  withPlayground(root);
  synced(root);
  const workspace: unknown = parse(read(root, "pnpm-workspace.yaml"));
  assert.deepEqual(workspace, {
    allowBuilds: { lefthook: false },
    ...FRESH_INTERFACES,
  });
});

test("sync keeps a nested pnpm-workspace.yaml that holds only the interface pattern in a pnpm 10 repository, where a sync that asks the root to delete such a file asks it of every install folder", (t) => {
  const root = pinnedRepo(t, "pnpm@10.6.5");
  withPlayground(root);
  const content = 'minimumReleaseAgeExclude:\n  - "@antelopejs/interface-*"\n';
  put(root, PLAYGROUND_WORKSPACE, content);
  synced(root);
  assert.equal(read(root, PLAYGROUND_WORKSPACE), content);
});

test("sync writes no pnpm-workspace.yaml beside a pnpm-lock.yaml that .gitignore leaves out, where a sync that walks ignored folders writes into node_modules", (t) => {
  const root = pinnedRepo(t, "pnpm@11.27.1");
  put(root, "node_modules/dep/pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
  synced(root);
  assert.equal(
    existsSync(join(root, "node_modules/dep/pnpm-workspace.yaml")),
    false,
  );
});

test("sync --profile template writes a pnpm-workspace.yaml that holds only the interface pattern, then reports no drift, where a template sync that writes no file lets a fresh install lock two copies of an interface released less than a day ago and one that decides lefthook declares a build the template does not install", (t) => {
  const root = pinnedRepo(t, "pnpm@11.27.1");
  synced(root, TEMPLATE);
  assert.deepEqual(parse(read(root, "pnpm-workspace.yaml")), FRESH_INTERFACES);
  const check = bin(root, "sync", [...TEMPLATE, "--check"]);
  assert.equal(check.status, 0, check.stdout + check.stderr);
});

test("sync --profile template asks a pnpm 11 pin below 11.27.1 to rise and writes no root file, where a sync that writes it makes that pnpm install a nested project into the repository root", (t) => {
  const root = pinnedRepo(t, "pnpm@11.27.0");
  const result = bin(root, "sync", TEMPLATE);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(
    result.stdout + result.stderr,
    /to lock one copy of an interface[^\n]*pnpm@11\.27\.1/,
  );
  assert.equal(existsSync(join(root, "pnpm-workspace.yaml")), false);
});

test("sync --profile template asks a pnpm 10 repository to delete a pnpm-workspace.yaml that holds only the interface pattern, where a sync that keeps it keeps nested installs going to the root", (t) => {
  const root = pinnedRepo(t, "pnpm@10.6.5");
  put(
    root,
    "pnpm-workspace.yaml",
    'minimumReleaseAgeExclude:\n  - "@antelopejs/interface-*"\n',
  );
  const result = bin(root, "sync", TEMPLATE);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /Delete pnpm-workspace\.yaml/);
});

test("sync lists the interface pattern in the pnpm-workspace.yaml of a pnpm-locked playground in an npm repository and writes no root file, then reports no drift, where a sync that skips every folder of a non-pnpm root lets that playground's pnpm 11 install lock two copies of an interface released less than a day ago", (t) => {
  const root = pinnedRepo(t, "npm@10.9.0");
  withPlayground(root);
  synced(root);
  assert.deepEqual(parse(read(root, PLAYGROUND_WORKSPACE)), FRESH_INTERFACES);
  assert.equal(existsSync(join(root, "pnpm-workspace.yaml")), false);
  const check = bin(root, "sync", ["--check"]);
  assert.equal(check.status, 0, check.stdout + check.stderr);
});

test("sync writes no pnpm-workspace.yaml in an unlocked playground below a package-lock.json, where a sync that writes one in every playground of an npm repository adds a pnpm file to a folder npm installs", (t) => {
  const root = pinnedRepo(t, "npm@10.9.0");
  put(root, "package-lock.json", '{ "lockfileVersion": 3 }\n');
  put(root, "playground/package.json", '{ "private": true }\n');
  synced(root);
  assert.equal(existsSync(join(root, PLAYGROUND_WORKSPACE)), false);
});
