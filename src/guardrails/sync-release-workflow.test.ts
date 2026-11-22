import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { parseDocument } from "yaml";

import { bin, formatCheck, put, read, testRepo } from "./helpers/test-repo.ts";
import { NEXT_SYNC_PATH, RELEASE_PATH } from "./release-workflow.ts";
import { syncRepository } from "./sync.ts";

const NEXT_SYNC = NEXT_SYNC_PATH;

const OLD_DISPATCH = `on:
  workflow_dispatch:
    inputs:
      channel:
        description: npm distribution channel
        required: true
        default: latest
        type: choice
        options: [latest, next]
      release-version:
        description: Exact stable version
        required: false
        type: string

permissions:
  contents: write
  id-token: write
`;

const MONGODB = `name: Release

${OLD_DISPATCH}
jobs:
  release:
    uses: AntelopeJS/.github/.github/workflows/release-npm-public.yml@v1
    with:
      channel: \${{ inputs.channel }}
      release-version: \${{ inputs.release-version }}
    secrets:
      RELEASE_GITHUB_TOKEN: \${{ secrets.RELEASE_GITHUB_TOKEN }}
`;

const VALIDATED = (file: string, directory?: string) => `name: Release

${OLD_DISPATCH}
jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - run: test "$CHANNEL" = latest

  release:
    needs: validate
    uses: AntelopeJS/.github/.github/workflows/${file}@492c1f55e32fa1b7bd2c5a65a1714498930d9e20
    with:
      channel: \${{ inputs.channel }}
      release-version: \${{ inputs.release-version }}
${directory === undefined ? "" : `      package-directory: ${directory}\n`}    secrets:
      RELEASE_GITHUB_TOKEN: \${{ secrets.RELEASE_GITHUB_TOKEN }}
`;

const BREVO_PRIVATE = `name: Release

on:
  workflow_dispatch:
    inputs:
      channel:
        required: true
        type: choice
        options: [latest, next]

permissions:
  contents: write

jobs:
  release:
    uses: AntelopeJS/.github/.github/workflows/release-npm-private.yml@v1
    with:
      channel: \${{ inputs.channel }}
      install-core: false
    secrets:
      RELEASE_GITHUB_TOKEN: \${{ secrets.RELEASE_GITHUB_TOKEN }}
      NPM_ANTELOPE_TOKEN: \${{ secrets.NPM_ANTELOPE_TOKEN }}
`;

const CLOUD_SDK = `name: Release public npm package

on:
  workflow_dispatch:
    inputs:
      package:
        required: true
        type: choice
        options: [sdk, cli]
      channel:
        required: true
        type: choice
        options: [latest, next]

jobs:
  release:
    uses: AntelopeJS/.github/.github/workflows/release-npm-public.yml@7ad269a39f1a59ca8469f6002c0b15820ff911be
    with:
      channel: \${{ inputs.channel }}
      package-directory: \${{ inputs.package }}
    secrets:
      RELEASE_GITHUB_TOKEN: \${{ secrets.RELEASE_GITHUB_TOKEN }}
`;

interface ReleaseView {
  on: {
    push: { branches: string[] };
    pull_request: { types: string[] };
    workflow_dispatch: { inputs: Record<string, { default?: string }> };
  };
  permissions: Record<string, string>;
  jobs: Record<
    string,
    {
      if?: string;
      uses: string;
      with: Record<string, string | boolean>;
      secrets: Record<string, string>;
    }
  >;
}

function release(root: string): ReleaseView {
  return parseDocument(read(root, RELEASE_PATH)).toJS();
}

function repoWith(
  t: test.TestContext,
  files: Record<string, string>,
  name = "@antelopejs/mongodb",
): string {
  const root = testRepo(t);
  put(root, "package.json", JSON.stringify({ name, type: "module" }));
  for (const [path, content] of Object.entries(files)) put(root, path, content);
  return root;
}

test("a public caller on the channel interface becomes the release-train caller at @v2, so a sync that keeps channel or only bumps the ref fails", (t) => {
  const root = repoWith(t, { [RELEASE_PATH]: MONGODB });
  const result = syncRepository(root);
  assert.deepEqual(result.errors, []);
  const synced = release(root);
  assert.deepEqual(synced.on.push, { branches: ["main"] });
  assert.deepEqual(Object.keys(synced.on.workflow_dispatch.inputs), [
    "release-version",
    "release-commit",
    "dependency-ranges",
  ]);
  assert.equal(
    synced.on.workflow_dispatch.inputs["dependency-ranges"].default,
    "{}",
  );
  assert.deepEqual(synced.permissions, {
    contents: "write",
    "id-token": "write",
  });
  assert.deepEqual(synced.jobs.release, {
    uses: "AntelopeJS/.github/.github/workflows/release-npm-public.yml@v2",
    with: {
      "release-version": "${{ inputs.release-version }}",
      "release-commit": "${{ inputs.release-commit }}",
      "dependency-ranges": "${{ inputs.dependency-ranges }}",
    },
    secrets: {
      RELEASE_APP_ID: "${{ secrets.RELEASE_APP_ID }}",
      RELEASE_APP_PRIVATE_KEY: "${{ secrets.RELEASE_APP_PRIVATE_KEY }}",
    },
  });
  assert.ok(result.notes.some((note) => note.includes("input channel")));
  assert.equal(syncRepository(root, { check: true }).paths.length, 0);
});

test("a labelled pull request republishes its preview on each push: release.yml runs on labeled, synchronize and reopened, and every job of a workspace admits it, so a caller with no pull_request trigger or a push-only gate leaves the preview label without effect", (t) => {
  const single = repoWith(t, { [RELEASE_PATH]: BREVO_PRIVATE });
  syncRepository(single);
  const workspace = repoWith(t, {
    [RELEASE_PATH]: MONGODB,
    ".github/workflows/release-sub.yml": VALIDATED(
      "release-npm-public.yml",
      "packages/sub",
    ),
  });
  syncRepository(workspace);
  for (const root of [single, workspace])
    assert.deepEqual(release(root).on.pull_request, {
      types: ["labeled", "synchronize", "reopened"],
    });
  for (const job of Object.values(release(workspace).jobs))
    assert.match(
      job.if ?? "",
      /^github\.event_name != 'workflow_dispatch' \|\| /,
    );
});

test("a DMS caller drops its validate job and its SHA pin, and names the job in a note, so a sync that leaves a job reading inputs.channel fails", (t) => {
  const root = repoWith(t, {
    [RELEASE_PATH]: VALIDATED("release-npm-public.yml"),
  });
  const result = syncRepository(root);
  assert.deepEqual(Object.keys(release(root).jobs), ["release"]);
  assert.match(read(root, RELEASE_PATH), /release-npm-public\.yml@v2\n/);
  assert.ok(result.notes.some((note) => note.includes("job validate")));
});

test("a private package keeps its install-core and gets both secrets and no id-token, so a sync that writes the public caller or the private default fails", (t) => {
  const root = repoWith(t, { [RELEASE_PATH]: BREVO_PRIVATE });
  syncRepository(root);
  const synced = release(root);
  assert.deepEqual(synced.permissions, { contents: "write" });
  assert.equal(
    synced.jobs.release.uses,
    "AntelopeJS/.github/.github/workflows/release-npm-private.yml@v2",
  );
  assert.equal(synced.jobs.release.with["install-core"], false);
  assert.deepEqual(Object.keys(synced.jobs.release.secrets), [
    "RELEASE_APP_ID",
    "RELEASE_APP_PRIVATE_KEY",
    "NPM_ANTELOPE_TOKEN",
  ]);
});

test("a nested package forwards the train's package-directory with its own directory as fallback", (t) => {
  const root = repoWith(t, {
    [RELEASE_PATH]: VALIDATED("release-npm-public.yml", "./packages/dms/"),
  });
  syncRepository(root);
  const synced = release(root);
  assert.ok("package-directory" in synced.on.workflow_dispatch.inputs);
  assert.equal(
    synced.jobs.release.with["package-directory"],
    "${{ inputs.package-directory || 'packages/dms' }}",
  );
});

test("a workspace with an interface caller in another file gets one release.yml with a job per package and loses the other file, so the train that dispatches release.yml reaches both", (t) => {
  const root = repoWith(t, {
    [RELEASE_PATH]: VALIDATED("release-npm-public.yml", "packages/dms-mailing"),
    ".github/workflows/release-interface.yml": VALIDATED(
      "release-npm-public.yml",
      "packages/interface-dms-mailing",
    ),
  });
  const result = syncRepository(root);
  assert.deepEqual(result.errors, []);
  assert.ok(result.removed.includes(".github/workflows/release-interface.yml"));
  assert.equal(
    existsSync(join(root, ".github/workflows/release-interface.yml")),
    false,
  );
  const { jobs } = release(root);
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(jobs).map(([id, job]) => [
        id,
        [job.if, job.with["package-directory"]],
      ]),
    ),
    {
      "release-packages-dms-mailing": [
        "github.event_name != 'workflow_dispatch' || inputs.package-directory == 'packages/dms-mailing'",
        "packages/dms-mailing",
      ],
      "release-packages-interface-dms-mailing": [
        "github.event_name != 'workflow_dispatch' || inputs.package-directory == 'packages/interface-dms-mailing'",
        "packages/interface-dms-mailing",
      ],
    },
  );
  assert.equal(formatCheck(root, [RELEASE_PATH]).status, 0);
  assert.equal(syncRepository(root, { check: true }).paths.length, 0);
});

test("a caller whose package-directory reads a choice input releases each choice, and one reading anything else is an error rather than a guess", (t) => {
  const root = repoWith(t, { ".github/workflows/release-npm.yml": CLOUD_SDK });
  syncRepository(root);
  assert.deepEqual(Object.keys(release(root).jobs), [
    "release-cli",
    "release-sdk",
  ]);
  const unknown = repoWith(t, {
    [RELEASE_PATH]: CLOUD_SDK.replace("inputs.package }}", "env.DIR }}"),
  });
  assert.match(
    syncRepository(unknown).errors.join("\n"),
    /names no package directory/,
  );
});

test("a repository with no release caller gets no release.yml and no next-sync caller, so a sync that still writes the retired caller fails", (t) => {
  const root = repoWith(t, {});
  syncRepository(root);
  assert.equal(existsSync(join(root, RELEASE_PATH)), false);
  assert.equal(existsSync(join(root, NEXT_SYNC)), false);
});

test("cloud keeps develop: its next-sync caller merges main into develop and its preview pushes on develop, and a second sync changes nothing, so a sync that moves cloud to trunk or retires its next-sync fails", (t) => {
  const root = repoWith(
    t,
    { [RELEASE_PATH]: MONGODB },
    "@antelopejs-private/cloud",
  );
  const result = syncRepository(root);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.removed, []);
  const nextSync = parseDocument(read(root, NEXT_SYNC)).toJS();
  assert.deepEqual(nextSync.on, {
    push: { branches: ["main"] },
    workflow_dispatch: null,
  });
  assert.deepEqual(nextSync.jobs["next-sync"].permissions, { issues: "write" });
  assert.equal(
    nextSync.jobs["next-sync"].uses,
    "AntelopeJS/.github/.github/workflows/next-sync.yml@v2",
  );
  assert.deepEqual(nextSync.jobs["next-sync"].with, { branch: "develop" });
  assert.deepEqual(nextSync.jobs["next-sync"].secrets, {
    RELEASE_APP_ID: "${{ secrets.RELEASE_APP_ID }}",
    RELEASE_APP_PRIVATE_KEY: "${{ secrets.RELEASE_APP_PRIVATE_KEY }}",
    NOTION_TOKEN: "${{ secrets.NOTION_TOKEN }}",
  });
  assert.deepEqual(release(root).on.push, { branches: ["develop"] });
  assert.equal(formatCheck(root, [NEXT_SYNC]).status, 0);
  assert.equal(syncRepository(root, { check: true }).paths.length, 0);
});

test("sync removes a RELEASE_GITHUB_TOKEN line from an existing release.yml and next-sync.yml and then passes --check, so a sync that keeps forwarding the retired secret fails", (t) => {
  const root = repoWith(
    t,
    { [RELEASE_PATH]: MONGODB },
    "@antelopejs-private/cloud",
  );
  syncRepository(root);
  const token =
    "      RELEASE_GITHUB_TOKEN: ${{ secrets.RELEASE_GITHUB_TOKEN }}\n";
  for (const path of [RELEASE_PATH, NEXT_SYNC]) {
    const synced = read(root, path);
    const marker = "    secrets:\n";
    put(root, path, synced.replace(marker, `${marker}${token}`));
    assert.ok(read(root, path).includes("RELEASE_GITHUB_TOKEN"));
  }
  syncRepository(root);
  assert.equal(
    read(root, RELEASE_PATH).includes("RELEASE_GITHUB_TOKEN"),
    false,
  );
  assert.equal(read(root, NEXT_SYNC).includes("RELEASE_GITHUB_TOKEN"), false);
  assert.equal(syncRepository(root, { check: true }).paths.length, 0);
});

test("a scaffold synced under the template profile gets no next-sync caller", (t) => {
  const root = repoWith(t, {});
  syncRepository(root, { profile: "template" });
  assert.equal(existsSync(join(root, NEXT_SYNC)), false);
});

const NEXT_SYNC_CALLER = (ref: string) =>
  `name: Next sync\non:\n  push:\n    branches: [main]\n  workflow_dispatch:\npermissions: {}\njobs:\n  next-sync:\n    permissions:\n      issues: write\n    uses: AntelopeJS/.github/.github/workflows/next-sync.yml@${ref}\n    secrets:\n      RELEASE_GITHUB_TOKEN: \${{ secrets.RELEASE_GITHUB_TOKEN }}\n`;
const STALE_CALLER = (ref: string) =>
  `name: Stale issues\non:\n  schedule:\n    - cron: "30 1 * * *"\npermissions: {}\njobs:\n  stale:\n    permissions:\n      issues: write\n    uses: AntelopeJS/.github/.github/workflows/stale.yml@${ref}\n`;
const STALE = ".github/workflows/stale.yml";

test("sync deletes a next-sync.yml and a stale.yml that only call the shared workflows, at any ref, and a second sync has nothing left to remove, so a sync that keeps them or fails to converge fails", (t) => {
  const root = repoWith(t, {
    [NEXT_SYNC]: NEXT_SYNC_CALLER("v1"),
    [STALE]: STALE_CALLER("v2"),
    ".github/workflows/old-name.yaml": STALE_CALLER("abc123"),
  });
  const result = syncRepository(root);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(
    result.removed.sort(),
    [NEXT_SYNC, ".github/workflows/old-name.yaml", STALE].sort(),
  );
  for (const path of result.removed)
    assert.equal(existsSync(join(root, path)), false, path);
  const again = syncRepository(root);
  assert.deepEqual(again.removed, []);
  assert.equal(syncRepository(root, { check: true }).paths.length, 0);
});

test("a workflow that calls a retired shared workflow beside another job is kept and no longer pinned, so a sync that deletes the whole file or re-pins it fails", (t) => {
  const mixed = `${STALE_CALLER("v1")}  lint:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo lint\n`;
  const root = repoWith(t, { [STALE]: mixed });
  const result = syncRepository(root);
  assert.deepEqual(result.removed, []);
  assert.equal(read(root, STALE), mixed);
});

test("sync --check reports a leftover next-sync caller and stale caller as drift and passes once they are gone, so a check that ignores retired callers fails", (t) => {
  const root = repoWith(t, {
    [NEXT_SYNC]: NEXT_SYNC_CALLER("v2"),
    [STALE]: STALE_CALLER("v2"),
  });
  assert.equal(bin(root, "sync").status, 0);
  put(root, NEXT_SYNC, NEXT_SYNC_CALLER("v2"));
  put(root, STALE, STALE_CALLER("v1"));
  const check = bin(root, "sync", ["--check"]);
  assert.equal(check.status, 1);
  assert.match(check.stdout, /Drift: \.github\/workflows\/next-sync\.yml/);
  assert.match(check.stdout, /Drift: \.github\/workflows\/stale\.yml/);
  assert.equal(existsSync(join(root, NEXT_SYNC)), true);
  assert.equal(bin(root, "sync").status, 0);
  assert.equal(bin(root, "sync", ["--check"]).status, 0);
});

test("sync:check fails a release caller on an older ref and passes once synced", (t) => {
  const root = repoWith(t, {
    [RELEASE_PATH]: MONGODB,
    ".github/workflows/ci.yml":
      "jobs:\n  ci:\n    uses: AntelopeJS/.github/.github/workflows/ci-node.yml@v1\n",
  });
  assert.equal(bin(root, "sync").status, 0);
  assert.equal(bin(root, "sync", ["--check"]).status, 0);
  assert.match(read(root, ".github/workflows/ci.yml"), /ci-node\.yml@v2\n/);
  put(root, RELEASE_PATH, read(root, RELEASE_PATH).replace("@v2", "@v1"));
  const check = bin(root, "sync", ["--check"]);
  assert.equal(check.status, 1);
  assert.match(check.stdout, /Drift: \.github\/workflows\/release\.yml/);
});

test("every other workflow's call to a shared workflow the tag ships moves to @v2 byte for byte, and a retired one keeps its ref, so a sync that leaves ci-renovate-sync.yml on @v1 or rewrites modules-update.yml fails", (t) => {
  const renovate = `name: Renovate sync\non:\n  schedule:\n    - cron: "30 1 * * *"\npermissions: {}\njobs:\n  sync:\n    permissions:\n      contents: write\n    uses: AntelopeJS/.github/.github/workflows/ci-renovate-sync.yml@v1 # daily\n`;
  const modules = `on: workflow_dispatch\njobs:\n  modules-update:\n    uses: AntelopeJS/.github/.github/workflows/modules-update.yml@v1\n`;
  const root = repoWith(t, {
    ".github/workflows/renovate-sync.yml": renovate,
    ".github/workflows/modules-update.yml": modules,
  });
  assert.equal(
    syncRepository(root, { check: true }).paths.includes(
      ".github/workflows/renovate-sync.yml",
    ),
    true,
  );
  syncRepository(root);
  assert.equal(
    read(root, ".github/workflows/renovate-sync.yml"),
    renovate.replace("ci-renovate-sync.yml@v1", "ci-renovate-sync.yml@v2"),
  );
  assert.equal(read(root, ".github/workflows/modules-update.yml"), modules);
  assert.equal(syncRepository(root, { check: true }).paths.length, 0);
});

test("dms's interface caller, a choice input behind a path prefix, migrates with the root caller into one job per package, so a sync that only reads a bare input aborts", (t) => {
  const interfaces = CLOUD_SDK.replace(
    "options: [sdk, cli]",
    "options: [interface-dms, interface-dms-builder]",
  ).replace(
    "package-directory: ${{ inputs.package }}",
    "package-directory: packages/${{ inputs.package }}",
  );
  const root = repoWith(t, {
    [RELEASE_PATH]: VALIDATED("release-npm-public.yml", "packages/dms"),
    ".github/workflows/release-interface.yml": interfaces,
  });
  assert.deepEqual(syncRepository(root).errors, []);
  assert.deepEqual(Object.keys(release(root).jobs), [
    "release-packages-dms",
    "release-packages-interface-dms",
    "release-packages-interface-dms-builder",
  ]);
});

test("a root package beside a nested one runs on a train dispatch that leaves package-directory out, so a gate on '.' alone skips its stable release", (t) => {
  const root = repoWith(t, {
    [RELEASE_PATH]: MONGODB,
    ".github/workflows/release-sub.yml": VALIDATED(
      "release-npm-public.yml",
      "packages/sub",
    ),
  });
  syncRepository(root);
  assert.equal(
    release(root).jobs["release-root"].if,
    "github.event_name != 'workflow_dispatch' || inputs.package-directory == '' || inputs.package-directory == '.'",
  );
});

test("a release caller sharing its file with a job it does not need stops sync with the file untouched, so a sync that deletes the other job fails", (t) => {
  const ci = `on: pull_request\njobs:\n  lint:\n    runs-on: ubuntu-latest\n    steps:\n      - run: pnpm run checks\n  publish:\n    uses: AntelopeJS/.github/.github/workflows/release-npm-public.yml@v1\n`;
  const root = repoWith(t, { ".github/workflows/publish.yml": ci });
  const result = syncRepository(root);
  assert.match(
    result.errors.join("\n"),
    /the job lint is not part of the release/,
  );
  assert.equal(read(root, ".github/workflows/publish.yml"), ci);
});
