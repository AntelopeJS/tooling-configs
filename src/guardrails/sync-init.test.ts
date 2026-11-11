import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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

test("the last install of --init sees every tool the synced scripts and hooks call, where an init that skips the second install or leaves oxfmt undeclared breaks `pnpm install --frozen-lockfile` or `format`", (t) => {
  const root = bareRepo(t);
  const tools = fakeTools(t);
  assert.equal(bin(root, "sync", ["--init"], tools.env).status, 0);
  const last = tools.installs().at(-1) ?? [];
  for (const tool of [
    "@antelopejs/tooling-configs",
    "oxlint",
    "oxlint-tsgolint",
    "oxfmt",
    "knip",
    "lefthook",
  ])
    assert.ok(last.includes(tool), `${tool} is missing from ${last}`);
});

test("--init leaves package.json passing `oxfmt --check` and names it once, where an init that leaves the appended keys unsorted fails the repository's format:check and one that prints each writer's path lists it twice", (t) => {
  const root = bareRepo(t);
  const tools = fakeTools(t);
  const result = bin(root, "sync", ["--init"], tools.env);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const check = spawnSync(
    process.execPath,
    [join(root, "node_modules/oxfmt/bin/oxfmt"), "--check", "package.json"],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(check.status, 0, check.stdout + check.stderr);
  assert.equal(result.stdout.split("Updated: package.json").length - 1, 1);
});

test("--init still turns delete_branch_on_merge on and exits 1 when an install fails, where an init that skips gh after a failure leaves the setting off", (t) => {
  for (const failingInstall of [1, 2]) {
    const root = bareRepo(t);
    const tools = fakeTools(t, { failingInstall });
    const result = bin(root, "sync", ["--init"], tools.env);
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, /ERR_PNPM_IGNORED_BUILDS/);
    assert.match(result.stderr, /rerun antelopejs-sync --init/);
    assert.deepEqual(patches(tools.calls()), [ENABLE_BRANCH_CLEANUP]);
    assert.equal(tools.patched(), true);
  }
});

test("--init tells the user to rerun itself when sync reports an error, where an init that repeats sync's advice sends them to plain sync and never reaches the second install or gh", (t) => {
  const root = bareRepo(t);
  const tools = fakeTools(t);
  put(root, "renovate.json", '{"extends":["config:recommended"]}\n');
  const result = bin(root, "sync", ["--init"], tools.env);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /rerun antelopejs-sync --init/);
  assert.deepEqual(patches(tools.calls()), [ENABLE_BRANCH_CLEANUP]);
  assert.equal(tools.installs().length, 1);
});

test("--init reports an oxfmt that cannot load its config and asks for a rerun, where an init that ignores oxfmt's exit leaves package.json unsorted and format:check red", (t) => {
  const root = bareRepo(t);
  const tools = fakeTools(t);
  put(
    root,
    "oxfmt.config.ts",
    'import { antelopeFmtPreset } from "@antelopejs/tooling-configs/oxc/fmt";\nimport "./missing.ts";\nexport default antelopeFmtPreset();\n',
  );
  const result = bin(root, "sync", ["--init"], tools.env);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /oxfmt failed/);
  assert.match(result.stderr, /rerun antelopejs-sync --init/);
});

test("--init finishes when the repository's oxfmt config ignores package.json, where an init that formats the file by name fails on every rerun", (t) => {
  const root = bareRepo(t);
  const tools = fakeTools(t);
  put(
    root,
    "oxfmt.config.ts",
    'import { antelopeFmtPreset } from "@antelopejs/tooling-configs/oxc/fmt";\nexport default antelopeFmtPreset({ ignorePatterns: ["package.json"] });\n',
  );
  const result = bin(root, "sync", ["--init"], tools.env);
  assert.equal(result.status, 0, result.stderr + result.stdout);
});

test("--init names package.json when only its oxfmt pass rewrites it, where an init that formats silently prints 'in sync' over a changed file", (t) => {
  const root = bareRepo(t);
  const tools = fakeTools(t);
  assert.equal(bin(root, "sync", ["--init"], tools.env).status, 0);
  const manifest = parseManifest(read(root, "package.json"));
  const { packageManager: pinned, ...rest } = manifest;
  put(
    root,
    "package.json",
    `${JSON.stringify({ packageManager: pinned, ...rest }, null, 2)}\n`,
  );
  const result = bin(root, "sync", ["--init"], tools.env);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /^Updated: package\.json$/m);
});

test("--init with an unsupported package manager fails before it writes, where an init that checks it after the bootstrap leaves a half-onboarded repository", (t) => {
  const root = bareRepo(t);
  const tools = fakeTools(t);
  put(
    root,
    "package.json",
    '{\n  "name": "bare",\n  "packageManager": "deno@2"\n}\n',
  );
  const before = workingTree(root);
  const result = bin(root, "sync", ["--init"], tools.env);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unsupported package manager deno/);
  assert.deepEqual(workingTree(root), before);
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

test("--init names docs-typescript-project for the docs files whose TypeScript fences the docs check typechecks, where an init that stays silent leaves the first docs check red on fences the root tsconfig cannot resolve", (t) => {
  const root = bareRepo(t);
  const tools = fakeTools(t);
  put(
    root,
    ".github/workflows/ci.yml",
    "name: ci\non:\n  pull_request:\njobs:\n  ci:\n    uses: AntelopeJS/.github/.github/workflows/ci-node.yml@v1\n",
  );
  put(
    root,
    "README.md",
    '# onboarded\n\n```ts\nimport { value } from "onboarded";\n```\n',
  );
  put(root, "docs/guide.md", "# Guide\n\n```ts fragment\nvalue;\n```\n");
  const result = bin(root, "sync", ["--init"], tools.env);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(read(root, ".github/workflows/ci.yml"), /docs-files:/);
  const note = result.stdout
    .split("\n")
    .filter((line) => line.includes("docs-typescript-project"));
  assert.equal(note.length, 1, result.stdout);
  assert.ok(note[0].includes("README.md"), note[0]);
  assert.ok(!note[0].includes("docs/guide.md"), note[0]);
  put(
    root,
    ".github/workflows/ci.yml",
    read(root, ".github/workflows/ci.yml").replace(
      "      docs-files: |",
      "      docs-typescript-project: tsconfig.json\n      docs-files: |",
    ),
  );
  const rerun = bin(root, "sync", ["--init"], tools.env);
  assert.equal(rerun.status, 0, rerun.stderr + rerun.stdout);
  assert.doesNotMatch(rerun.stdout, /docs-typescript-project/);
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
