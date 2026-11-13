import assert from "node:assert/strict";
import test from "node:test";

import { runsOnWindows, windowsByDefault } from "./workflow-windows.ts";
import { windowsCi } from "./checks/windows.ts";
import { CALLER } from "./helpers/builders.ts";
import { FakeApi } from "./helpers/fake-api.ts";
import { isStackRepo } from "./stack.ts";
import type { CheckResult } from "./types.ts";

const WINDOWS_CALLER = CALLER.replace(
  "      renovate-sync: false",
  "      renovate-sync: false\n      windows: true",
);

const ciNode = (fallback: boolean) =>
  `on:\n  workflow_call:\n    inputs:\n      windows:\n        default: ${fallback}\n        type: boolean\njobs: {}\n`;

const pre48 = (text: string) => runsOnWindows(text, async () => false);

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
    "mysql",
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
    ".github",
  ];
  assert.deepEqual(
    stack.filter((name) => !isStackRepo(name)),
    [],
  );
  assert.deepEqual(outside.filter(isStackRepo), []);
});

test("a workflow runs on Windows through a ci-node.yml caller with windows: true, a windows runs-on, or a windows entry in the matrix runs-on reads", async () => {
  assert.equal(await pre48(WINDOWS_CALLER), true);
  assert.equal(await pre48(CALLER), false);
  assert.equal(
    await pre48(
      "on: push\njobs:\n  t:\n    runs-on: windows-latest\n    steps: []\n",
    ),
    true,
  );
  assert.equal(
    await pre48(
      "on: push\njobs:\n  t:\n    runs-on: ${{ matrix.os }}\n    strategy:\n      matrix:\n        os: [ubuntu-latest, windows-latest]\n    steps: []\n",
    ),
    true,
  );
  assert.equal(
    await pre48(
      "on: push\njobs:\n  t:\n    runs-on: ubuntu-latest\n    strategy:\n      matrix:\n        target: [windows-latest]\n    steps: []\n",
    ),
    false,
  );
  assert.equal(await pre48("jobs: ["), false);
});

test("a Windows leg counts only when it runs: an excluded matrix value, another matrix key, a release-only workflow and an if: false job do not; anchors, merge keys, label case and expressions do", async () => {
  const job = (body: string, on = "pull_request") =>
    `on: ${on}\njobs:\n  t:\n${body}    steps: []\n`;
  const matrix = (os: string, extra = "") =>
    job(
      `    runs-on: \${{ matrix.os }}\n    strategy:\n      matrix:\n        os: ${os}\n${extra}`,
    );
  assert.deepEqual(
    {
      excluded: await pre48(
        matrix(
          "[ubuntu-latest, windows-latest]",
          "        exclude:\n          - os: windows-latest\n",
        ),
      ),
      otherKey: await pre48(
        matrix("[ubuntu-latest]", "        label: [windows-latest]\n"),
      ),
      releaseOnly: await pre48(job("    runs-on: windows-latest\n", "release")),
      disabled: await pre48(
        job("    if: false\n    runs-on: windows-latest\n"),
      ),
    },
    { excluded: false, otherKey: false, releaseOnly: false, disabled: false },
  );
  assert.deepEqual(
    {
      alias: await pre48(
        `x-os: &os windows-latest\non: push\njobs:\n  t:\n    runs-on: *os\n    steps: []\n`,
      ),
      merge: await pre48(
        `x-base: &base\n  runs-on: windows-latest\non: push\njobs:\n  t:\n    <<: *base\n    steps: []\n`,
      ),
      capitalised: await pre48(job("    runs-on: Windows-2022\n")),
      selfHosted: await pre48(
        job("    runs-on: [self-hosted, windows, x64]\n"),
      ),
      expression: await pre48(
        job(`    runs-on: \${{ fromJSON('["windows-latest"]') }}\n`),
      ),
      callerExpression: await pre48(
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

test("a ci-node.yml caller with no windows input follows the windows default of the ci-node.yml at its ref, and an explicit false wins over a true default", async () => {
  const refs: string[] = [];
  const post48 = async (ref: string) => {
    refs.push(ref);
    return true;
  };
  const optedOut = WINDOWS_CALLER.replace("windows: true", "windows: false");
  assert.deepEqual(
    {
      pre48: await pre48(CALLER),
      post48: await runsOnWindows(CALLER, post48),
      optedOut: await runsOnWindows(optedOut, post48),
      optedOutExpression: await runsOnWindows(
        optedOut.replace("windows: false", "windows: ${{ false }}"),
        post48,
      ),
    },
    { pre48: false, post48: true, optedOut: false, optedOutExpression: false },
  );
  assert.deepEqual(refs, ["v1"]);
  assert.deepEqual(
    [windowsByDefault(ciNode(true)), windowsByDefault(ciNode(false))],
    [true, false],
  );
});

test("windows-ci counts a caller with no windows input as running on Windows only while the ci-node.yml at its own ref defaults windows to true, and reports a caller whose ref has no ci-node.yml", async () => {
  const optedOut = WINDOWS_CALLER.replace("windows: true", "windows: false");
  const reported = async (fallback: boolean) =>
    keys(
      await windowsCi.run(
        new FakeApi()
          .org([
            { name: ".github" },
            { name: "mongodb" },
            { name: "mqtt" },
            { name: "redis" },
          ])
          .file(
            "/repos/AntelopeJS/.github/contents/.github/workflows/ci-node.yml?ref=v1",
            ciNode(fallback),
          )
          .repo("mongodb", { ".github/workflows/ci.yml": CALLER })
          .repo("mqtt", {
            ".github/workflows/ci.yml": CALLER.replace(
              "ci-node.yml@v1",
              "ci-node.yml@0000000000000000000000000000000000000000",
            ),
          })
          .repo("redis", { ".github/workflows/ci.yml": optedOut })
          .context(),
      ),
    );
  assert.deepEqual(
    { pre48: await reported(false), post48: await reported(true) },
    {
      pre48: [
        "mongodb|windows-ci|windows",
        "mqtt|windows-ci|windows",
        "redis|windows-ci|windows",
      ],
      post48: ["mqtt|windows-ci|windows", "redis|windows-ci|windows"],
    },
  );
});
