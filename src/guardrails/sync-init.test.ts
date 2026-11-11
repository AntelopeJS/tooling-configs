import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  conformance,
  deleteBranchOnMerge,
} from "../garden/checks/conformance.ts";
import type { CheckResult } from "../garden/types.ts";
import { fakeTools } from "./helpers/fake-tools.ts";
import { bareRepo, pushedWorld, workingTree } from "./helpers/init-repo.ts";
import { bin, put, read } from "./helpers/test-repo.ts";
import { ENABLE_BRANCH_CLEANUP } from "./init.ts";
import { parseManifest } from "./package.ts";

function subjects(result: CheckResult): string[] {
  assert.equal(result.kind, "findings");
  return result.kind === "findings"
    ? result.findings.map(({ subject }) => subject)
    : [];
}

function patches(calls: string[]): string[] {
  return calls.filter((call) => call.startsWith("gh") && /PATCH/.test(call));
}

test("the garden reports a bare repository's missing workflow, Renovate config and pack devDependency, so a clean result after --init is not an empty world", async (t) => {
  const root = bareRepo(t);
  const before = await conformance.run(pushedWorld(root, false).context());
  assert.deepEqual(subjects(before).toSorted(), [
    "ci-caller",
    "renovate-config",
    "tooling-configs",
  ]);
});

test("one --init run leaves a bare repository with no conformance finding; a run that skips the devDependency, the ignore file or the gh write leaves one", async (t) => {
  const root = bareRepo(t);
  const tools = fakeTools(t);
  const result = bin(root, "sync", ["--init"], tools.env);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const api = pushedWorld(root, tools.patched());
  assert.deepEqual(subjects(await conformance.run(api.context())), []);
  assert.deepEqual(subjects(await deleteBranchOnMerge.run(api.context())), []);
  assert.equal(read(root, ".gitignore"), "node_modules\n");
  assert.deepEqual(patches(tools.calls()), [ENABLE_BRANCH_CLEANUP]);
});

test("a second --init run changes no file and makes no second PATCH, where a run that writes without reading delete_branch_on_merge patches twice", (t) => {
  const root = bareRepo(t);
  const tools = fakeTools(t);
  assert.equal(bin(root, "sync", ["--init"], tools.env).status, 0);
  const first = workingTree(root);
  const second = bin(root, "sync", ["--init"], tools.env);
  assert.equal(second.status, 0, second.stderr + second.stdout);
  assert.deepEqual(workingTree(root), first);
  assert.equal(patches(tools.calls()).length, 1);
});

test("--init appends node_modules to an existing .gitignore and keeps the devDependencies it already declares, where an init that rewrites either loses the repository's own lines", (t) => {
  const root = bareRepo(t);
  const tools = fakeTools(t);
  put(root, ".gitignore", "dist");
  put(
    root,
    "package.json",
    '{\n  "name": "onboarded",\n  "type": "module",\n  "packageManager": "pnpm@10.20.0",\n  "devDependencies": {\n    "oxfmt": "^0.66.0",\n    "zod": "^4.0.0"\n  }\n}\n',
  );
  const result = bin(root, "sync", ["--init"], tools.env);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.equal(read(root, ".gitignore"), "dist\nnode_modules\n");
  const declared = parseManifest(read(root, "package.json")).devDependencies;
  assert.equal(declared?.oxfmt, "^0.66.0");
  assert.equal(declared?.zod, "^4.0.0");
  assert.ok(declared?.["@antelopejs/tooling-configs"]);
});

test("--init prints the PATCH command and exits 1 after the file work when gh refuses, where an init that ignores the refusal exits 0", (t) => {
  const root = bareRepo(t);
  const tools = fakeTools(t, { refusesPatch: true });
  const result = bin(root, "sync", ["--init"], tools.env);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /delete_branch_on_merge is not on/);
  assert.ok(result.stderr.includes(ENABLE_BRANCH_CLEANUP), result.stderr);
  assert.equal(result.stderr.trimEnd().split("\n").length, 1);
  assert.ok(existsSync(join(root, ".github/workflows/ci.yml")));
  assert.ok(
    parseManifest(read(root, "package.json")).devDependencies?.[
      "@antelopejs/tooling-configs"
    ],
  );
  assert.equal(tools.patched(), false);
});

test("--init rejects --check and --profile template before it touches the repository, where an init that ignores them runs a full sync", (t) => {
  const root = bareRepo(t);
  const tools = fakeTools(t);
  const before = workingTree(root);
  for (const flags of [["--check"], ["--profile", "template"]]) {
    const result = bin(root, "sync", ["--init", ...flags], tools.env);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /--init .* cannot be combined/);
  }
  assert.deepEqual(workingTree(root), before);
  assert.deepEqual(tools.calls(), []);
});

test("--init without a package.json fails and writes nothing, where an init that creates one hides a wrong directory", (t) => {
  const root = bareRepo(t);
  rmSync(join(root, "package.json"));
  const tools = fakeTools(t);
  const result = bin(root, "sync", ["--init"], tools.env);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /package\.json is missing/);
  assert.equal(existsSync(join(root, "package.json")), false);
  assert.equal(existsSync(join(root, ".gitignore")), false);
});
