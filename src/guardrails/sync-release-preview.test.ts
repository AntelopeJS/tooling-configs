import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { parseDocument } from "yaml";

import { formatCheck, put, read, testRepo } from "./helpers/test-repo.ts";
import { RELEASE_PATH } from "./release-workflow.ts";
import { syncRepository } from "./sync.ts";

const caller = (directory: string) => `name: Release

on:
  workflow_dispatch:

jobs:
  release:
    uses: AntelopeJS/.github/.github/workflows/release-npm-public.yml@v1
    with:
      package-directory: ${directory}
`;

interface Job {
  if?: string;
  needs?: string[];
}

/** Whether a job whose `if` is `condition` runs on `event` with `inputs`, when none of its needs failed. */
function runs(
  condition: string | undefined,
  event: string,
  inputs: Record<string, string | boolean>,
): boolean {
  const expression = (condition ?? "true")
    .replace(/^\$\{\{(.*)\}\}$/s, "$1")
    .replaceAll("!failure()", "true")
    .replaceAll("!cancelled()", "true")
    .replaceAll("github.event_name", JSON.stringify(event))
    .replace(/inputs\.([\w-]+)/g, (_, name: string) =>
      JSON.stringify(Object.hasOwn(inputs, name) ? inputs[name] : ""),
    );
  return runInNewContext(expression) === true;
}

test("a preview dispatch that names no package runs every job of a workspace, each after the siblings it depends on at runtime, while a dispatch for one package and a pull request run as before, so a gate that skips every job on a bare preview or publishes a dependent first fails", (t) => {
  const root = testRepo(t);
  const files = {
    "package.json": JSON.stringify({ name: "dms-workspace", type: "module" }),
    [RELEASE_PATH]: caller("packages/dms"),
    ".github/workflows/release-interface.yml": caller("packages/interface-dms"),
    ".github/workflows/release-builder.yml": caller(
      "packages/interface-dms-builder",
    ),
    "packages/dms/package.json": JSON.stringify({
      name: "@antelopejs/dms",
      dependencies: { "@antelopejs/interface-dms": "workspace:^" },
      peerDependencies: { "@antelopejs/interface-dms-builder": "workspace:^" },
      devDependencies: { "@antelopejs/mongodb": "^1.0.0" },
    }),
    "packages/interface-dms/package.json": JSON.stringify({
      name: "@antelopejs/interface-dms",
    }),
    "packages/interface-dms-builder/package.json": JSON.stringify({
      name: "@antelopejs/interface-dms-builder",
      devDependencies: { "@antelopejs/dms": "workspace:*" },
    }),
  };
  for (const [path, content] of Object.entries(files)) put(root, path, content);
  assert.deepEqual(syncRepository(root).errors, []);
  const jobs: Record<string, Job> = parseDocument(
    read(root, RELEASE_PATH),
  ).toJS().jobs;
  const dms = "release-packages-dms";
  const interfaceDms = "release-packages-interface-dms";
  const builder = "release-packages-interface-dms-builder";
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(jobs).map(([id, job]) => [id, job.needs ?? []]),
    ),
    { [dms]: [interfaceDms, builder], [interfaceDms]: [], [builder]: [] },
  );
  const ran = (event: string, inputs: Record<string, string | boolean>) =>
    Object.keys(jobs).filter((id) => runs(jobs[id].if, event, inputs));
  assert.deepEqual(ran("workflow_dispatch", { preview: true }), [
    dms,
    interfaceDms,
    builder,
  ]);
  assert.deepEqual(
    ran("workflow_dispatch", {
      preview: true,
      "package-directory": "packages/dms",
    }),
    [dms],
  );
  assert.deepEqual(
    ran("workflow_dispatch", {
      "release-version": "1.2.0",
      "package-directory": "packages/interface-dms",
    }),
    [interfaceDms],
  );
  assert.deepEqual(ran("workflow_dispatch", {}), []);
  assert.deepEqual(ran("pull_request", {}), [dms, interfaceDms, builder]);
  assert.equal(formatCheck(root, [RELEASE_PATH]).status, 0);
  assert.equal(syncRepository(root, { check: true }).paths.length, 0);
});

test("two released packages that depend on each other at runtime stop sync and --check with the cycle named and release.yml untouched, so a sync that writes jobs needing each other, which GitHub rejects at dispatch, fails", (t) => {
  const root = testRepo(t);
  const files = {
    "package.json": JSON.stringify({ name: "workspace", type: "module" }),
    [RELEASE_PATH]: caller("packages/a"),
    ".github/workflows/release-b.yml": caller("packages/b"),
    "packages/a/package.json": JSON.stringify({
      name: "@antelopejs/a",
      dependencies: { "@antelopejs/b": "workspace:^" },
    }),
    "packages/b/package.json": JSON.stringify({
      name: "@antelopejs/b",
      peerDependencies: { "@antelopejs/a": "workspace:^" },
    }),
  };
  for (const [path, content] of Object.entries(files)) put(root, path, content);
  const cycle = /packages\/a → packages\/b → packages\/a depend on each other/;
  assert.match(syncRepository(root, { check: true }).errors.join("\n"), cycle);
  assert.match(syncRepository(root).errors.join("\n"), cycle);
  assert.equal(read(root, RELEASE_PATH), caller("packages/a"));
});
