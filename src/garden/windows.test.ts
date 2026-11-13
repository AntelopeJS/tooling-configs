import assert from "node:assert/strict";
import test from "node:test";

import { runsOnWindows } from "./workflow-windows.ts";
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

test("a Windows leg counts only when it runs: an excluded matrix value, another matrix key, a release-only workflow and an if: false job do not; anchors, merge keys, label case and expressions do", () => {
  const job = (body: string, on = "pull_request") =>
    `on: ${on}\njobs:\n  t:\n${body}    steps: []\n`;
  const matrix = (os: string, extra = "") =>
    job(
      `    runs-on: \${{ matrix.os }}\n    strategy:\n      matrix:\n        os: ${os}\n${extra}`,
    );
  assert.deepEqual(
    {
      excluded: runsOnWindows(
        matrix(
          "[ubuntu-latest, windows-latest]",
          "        exclude:\n          - os: windows-latest\n",
        ),
      ),
      otherKey: runsOnWindows(
        matrix("[ubuntu-latest]", "        label: [windows-latest]\n"),
      ),
      releaseOnly: runsOnWindows(
        job("    runs-on: windows-latest\n", "release"),
      ),
      disabled: runsOnWindows(
        job("    if: false\n    runs-on: windows-latest\n"),
      ),
    },
    { excluded: false, otherKey: false, releaseOnly: false, disabled: false },
  );
  assert.deepEqual(
    {
      alias: runsOnWindows(
        `x-os: &os windows-latest\non: push\njobs:\n  t:\n    runs-on: *os\n    steps: []\n`,
      ),
      merge: runsOnWindows(
        `x-base: &base\n  runs-on: windows-latest\non: push\njobs:\n  t:\n    <<: *base\n    steps: []\n`,
      ),
      capitalised: runsOnWindows(job("    runs-on: Windows-2022\n")),
      selfHosted: runsOnWindows(
        job("    runs-on: [self-hosted, windows, x64]\n"),
      ),
      expression: runsOnWindows(
        job(`    runs-on: \${{ fromJSON('["windows-latest"]') }}\n`),
      ),
      callerExpression: runsOnWindows(
        WINDOWS_CALLER.replace("windows: true", "windows: ${{ true }}"),
      ),
    },
    {
      alias: true,
      merge: true,
      capitalised: true,
      selfHosted: true,
      expression: true,
      callerExpression: true,
    },
  );
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
