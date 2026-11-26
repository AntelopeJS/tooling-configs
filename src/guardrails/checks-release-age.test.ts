import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import { bin, put, testRepo } from "./helpers/test-repo.ts";

/** Every step but `pnpm:release-age`, so it alone decides the run. */
const OTHER_STEPS =
  "typecheck,lint,format:check,knip,test,size,suppressions,sync:check,git:identity";

const EXCLUDE = 'minimumReleaseAgeExclude:\n  - "@antelopejs/*"\n';

function pnpmRepo(t: TestContext, workspace?: string): string {
  const root = testRepo(t);
  put(root, "package.json", JSON.stringify({ packageManager: "pnpm@10.33.0" }));
  if (workspace !== undefined) put(root, "pnpm-workspace.yaml", workspace);
  return root;
}

function checks(root: string) {
  return bin(root, "checks", ["--no-services"], {
    ANTELOPEJS_CHECKS_SKIP: OTHER_STEPS,
  });
}

function failed(lines: string[]): string {
  return `[pnpm:release-age]\n${lines.join("\n")}\nRun antelopejs-sync.\nChecks: 0 passed, 1 failed, 9 skipped.\n`;
}

for (const [name, workspace, failure] of [
  [
    "a missing pnpm-workspace.yaml",
    undefined,
    "pnpm-workspace.yaml is missing, so pnpm installs a release the day it is published.",
  ],
  [
    "a missing minimumReleaseAge",
    EXCLUDE,
    "pnpm-workspace.yaml does not set minimumReleaseAge, so pnpm installs a release the day it is published.",
  ],
  [
    "a minimumReleaseAge of one hour",
    `minimumReleaseAge: 60\n${EXCLUDE}`,
    "pnpm-workspace.yaml sets minimumReleaseAge to 60, not a number of minutes of at least 1440 (one day), so pnpm installs a release published less than a day ago.",
  ],
  [
    "a minimumReleaseAge written as a string",
    `minimumReleaseAge: "1440"\n${EXCLUDE}`,
    'pnpm-workspace.yaml sets minimumReleaseAge to "1440", not a number of minutes of at least 1440 (one day), so pnpm installs a release published less than a day ago.',
  ],
  [
    "a missing minimumReleaseAgeExclude",
    "minimumReleaseAge: 1440\n",
    'pnpm-workspace.yaml does not list "@antelopejs/*" under minimumReleaseAgeExclude, so an install waits a day for an AntelopeJS release.',
  ],
  [
    "an exclusion of the interfaces alone",
    'minimumReleaseAge: 1440\nminimumReleaseAgeExclude:\n  - "@antelopejs/interface-*"\n',
    'pnpm-workspace.yaml does not list "@antelopejs/*" under minimumReleaseAgeExclude, so an install waits a day for an AntelopeJS release.',
  ],
] as const)
  test(`pnpm:release-age fails ${name} and names the file, where a step that reads only one of the two settings, compares the age as text or counts any @antelopejs entry as the pattern passes it`, (t) => {
    const root = pnpmRepo(t, workspace);
    const result = checks(root);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.equal(result.stdout, failed([failure]));
  });

test("pnpm:release-age passes an age above one day beside other exclusions, where a step that demands exactly 1440 or an exclusion list of one entry fails a repository that waits longer", (t) => {
  const root = pnpmRepo(
    t,
    'minimumReleaseAge: 2880\nminimumReleaseAgeExclude:\n  - left-pad\n  - "@antelopejs/*"\n',
  );
  const result = checks(root);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.stdout, "Checks: 1 passed, 0 failed, 9 skipped.\n");
});

test("pnpm:release-age fails a playground installed on its own without a pnpm-workspace.yaml, where a step that reads only the root file passes a playground pnpm installs without the root's settings", (t) => {
  const root = pnpmRepo(t, `minimumReleaseAge: 1440\n${EXCLUDE}`);
  put(root, "playground/package.json", '{ "private": true }\n');
  const result = checks(root);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(
    result.stdout,
    failed([
      "playground/pnpm-workspace.yaml is missing, so pnpm installs a release the day it is published.",
    ]),
  );
});

test("pnpm:release-age does not run in an npm repository, where a step that runs everywhere asks an npm repository for a pnpm file", (t) => {
  const root = testRepo(t);
  const result = checks(root);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.stdout, "Checks: 0 passed, 0 failed, 9 skipped.\n");
});

test("pnpm:release-age fails a nested package.json pinning a pnpm before 10.17.0 and names the file, where a step that reads only the root pin passes a frontend whose pnpm ignores minimumReleaseAge", (t) => {
  const root = pnpmRepo(t, `minimumReleaseAge: 1440\n${EXCLUDE}`);
  put(
    root,
    "frontend-vue/package.json",
    JSON.stringify({ packageManager: "pnpm@10.2.0" }),
  );
  put(
    root,
    "frontend-vue/node_modules/dep/package.json",
    '{"packageManager":"pnpm@9.0.0"}',
  );
  put(
    root,
    "frontend-vue/pnpm-workspace.yaml",
    `minimumReleaseAge: 1440\n${EXCLUDE}`,
  );
  const result = checks(root);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(
    result.stdout,
    failed([
      "frontend-vue/package.json pins packageManager to pnpm@10.2.0, and pnpm before 10.17.0 installs a release the day it is published, whatever minimumReleaseAge says.",
    ]),
  );
});
