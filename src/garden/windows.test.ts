import assert from "node:assert/strict";
import test from "node:test";

import { runsOnWindows } from "../guardrails/workflow.ts";
import { windowsCi } from "./checks/windows.ts";
import { CALLER } from "./helpers/builders.ts";
import { FakeApi } from "./helpers/fake-api.ts";
import { isStackRepo } from "./stack.ts";
import type { CheckResult } from "./types.ts";

const WINDOWS_CALLER = CALLER.replace(
  "      renovate-sync: false",
  "      renovate-sync: false\n      windows: true",
);

function keys(result: CheckResult): string[] {
  assert.equal(result.kind, "findings");
  return result.kind === "findings"
    ? result.findings.map(({ key }) => key)
    : [];
}

test("the stack is the framework, its interfaces, modules, file storages and templates, and DMS, but not dms-builder, cloud, the site, infra or agent repositories", () => {
  const stack = [
    "antelopejs",
    "tooling-configs",
    "interface-core",
    "api",
    "rethinkdb",
    "file-storage-s3",
    "template-dms",
    "dms",
    "dms-frontend",
  ];
  const outside = [
    "dms-builder",
    "cloud",
    "cloud-sdk",
    "cloud-pricing-app",
    "antelope-web",
    "k8s-gitops-infra",
    "video-kit",
    "agent-skills",
    "interfaces",
    "mysql",
    ".github",
  ];
  assert.deepEqual(
    stack.filter((name) => !isStackRepo(name)),
    [],
  );
  assert.deepEqual(outside.filter(isStackRepo), []);
});

test("a workflow runs on Windows through a ci-node.yml caller with windows: true, a windows runs-on, or a windows entry in the matrix runs-on reads", () => {
  assert.equal(runsOnWindows(WINDOWS_CALLER), true);
  assert.equal(runsOnWindows(CALLER), false);
  assert.equal(
    runsOnWindows(
      "on: push\njobs:\n  t:\n    runs-on: windows-latest\n    steps: []\n",
    ),
    true,
  );
  assert.equal(
    runsOnWindows(
      "on: push\njobs:\n  t:\n    runs-on: ${{ matrix.os }}\n    strategy:\n      matrix:\n        os: [ubuntu-latest, windows-latest]\n    steps: []\n",
    ),
    true,
  );
  assert.equal(
    runsOnWindows(
      "on: push\njobs:\n  t:\n    runs-on: ubuntu-latest\n    strategy:\n      matrix:\n        target: [windows-latest]\n    steps: []\n",
    ),
    false,
  );
  assert.equal(runsOnWindows("jobs: ["), false);
});

test("windows-ci reports each stack repository with no Windows job, and skips repositories outside the stack", async () => {
  const api = new FakeApi()
    .org([
      { name: "interface-core" },
      { name: "mongodb" },
      { name: "template-dms", pack: "template" },
      { name: "cloud" },
      { name: "dms-builder" },
    ])
    .repo("interface-core", { ".github/workflows/ci.yml": WINDOWS_CALLER })
    .repo("mongodb", { ".github/workflows/ci.yml": CALLER })
    .repo("template-dms", { "README.md": "Template.\n" })
    .repo("cloud", { ".github/workflows/ci.yml": CALLER })
    .repo("dms-builder", { ".github/workflows/ci.yml": CALLER });
  assert.deepEqual(keys(await windowsCi.run(api.context())), [
    "mongodb|windows-ci|windows",
    "template-dms|windows-ci|windows",
  ]);
});
