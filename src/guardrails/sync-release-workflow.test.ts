import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { parseDocument } from "yaml";

import { bin, formatCheck, put, read, testRepo } from "./helpers/test-repo.ts";
import { NEXT_SYNC_PATH, RELEASE_PATH } from "./release-workflow.ts";
import { syncRepository } from "./sync.ts";

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
  assert.deepEqual(synced.on.push, { branches: ["next"] });
  assert.deepEqual(Object.keys(synced.on.workflow_dispatch.inputs), [
    "release-version",
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
      "dependency-ranges": "${{ inputs.dependency-ranges }}",
    },
    secrets: { RELEASE_GITHUB_TOKEN: "${{ secrets.RELEASE_GITHUB_TOKEN }}" },
  });
  assert.ok(result.notes.some((note) => note.includes("input channel")));
  assert.equal(syncRepository(root, { check: true }).paths.length, 0);
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
    "RELEASE_GITHUB_TOKEN",
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
        "github.event_name == 'push' || inputs.package-directory == 'packages/dms-mailing'",
        "packages/dms-mailing",
      ],
      "release-packages-interface-dms-mailing": [
        "github.event_name == 'push' || inputs.package-directory == 'packages/interface-dms-mailing'",
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

test("a repository with no release caller gets no release.yml, and every full-profile repository gets the next-sync caller with issues: write at @v2", (t) => {
  const root = repoWith(t, {});
  syncRepository(root);
  assert.equal(existsSync(join(root, RELEASE_PATH)), false);
  const nextSync = parseDocument(read(root, NEXT_SYNC_PATH)).toJS();
  assert.deepEqual(nextSync.on, { push: { branches: ["main"] } });
  assert.deepEqual(nextSync.permissions, {});
  assert.deepEqual(nextSync.jobs["next-sync"].permissions, { issues: "write" });
  assert.equal(
    nextSync.jobs["next-sync"].uses,
    "AntelopeJS/.github/.github/workflows/next-sync.yml@v2",
  );
  assert.equal(nextSync.jobs["next-sync"].with, undefined);
  assert.equal(formatCheck(root, [NEXT_SYNC_PATH]).status, 0);
});

test("cloud syncs develop into the next-sync input and the preview trigger, so a sync that hard-codes next fails", (t) => {
  const root = repoWith(
    t,
    { [RELEASE_PATH]: MONGODB },
    "@antelopejs-private/cloud",
  );
  syncRepository(root);
  const nextSync = parseDocument(read(root, NEXT_SYNC_PATH)).toJS();
  assert.deepEqual(nextSync.jobs["next-sync"].with, { branch: "develop" });
  assert.deepEqual(release(root).on.push, { branches: ["develop"] });
});

test("a scaffold synced under the template profile gets no next-sync caller, since a project made from it has no next branch", (t) => {
  const root = repoWith(t, {});
  syncRepository(root, { profile: "template" });
  assert.equal(existsSync(join(root, NEXT_SYNC_PATH)), false);
});

test("sync:check, on a repository without a next branch, fails a release caller or next-sync caller on another ref and passes once synced", (t) => {
  const root = repoWith(t, {
    [RELEASE_PATH]: MONGODB,
    ".github/workflows/ci.yml":
      "jobs:\n  ci:\n    uses: AntelopeJS/.github/.github/workflows/ci-node.yml@v1\n",
  });
  assert.equal(bin(root, "sync").status, 0);
  assert.equal(bin(root, "sync", ["--check"]).status, 0);
  assert.match(read(root, ".github/workflows/ci.yml"), /ci-node\.yml@v2\n/);
  put(root, NEXT_SYNC_PATH, read(root, NEXT_SYNC_PATH).replace("@v2", "@v1"));
  const check = bin(root, "sync", ["--check"]);
  assert.equal(check.status, 1);
  assert.match(check.stdout, /Drift: \.github\/workflows\/next-sync\.yml/);
});
