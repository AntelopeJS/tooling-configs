import assert from "node:assert/strict";
import test from "node:test";
import { parseDocument } from "yaml";

import { placeholderTestScript } from "./ci-workflow.ts";
import {
  bin,
  commit,
  linkOxlint,
  put,
  read,
  testRepo,
} from "./helpers/test-repo.ts";

function testJob(root: string): string {
  return String(
    parseDocument(read(root, ".github/workflows/ci.yml")).getIn([
      "jobs",
      "ci",
      "with",
      "test-job",
    ]),
  );
}

function repoWithTest(t: test.TestContext, script: string | undefined): string {
  const root = testRepo(t, false);
  linkOxlint(root);
  put(
    root,
    "oxlint.config.ts",
    'import type {} from "@antelopejs/tooling-configs/oxc/lint";\nexport default {};\n',
  );
  const scripts = script === undefined ? {} : { test: script };
  put(
    root,
    "package.json",
    `${JSON.stringify({ name: "guardrails-test", type: "module", packageManager: "npm@11.0.0", scripts }, null, 2)}\n`,
  );
  commit(root);
  return root;
}

test("a placeholder test script turns the caller's test job off, where a sync that always writes test-job: true spends a runner on an echo", (t) => {
  const root = repoWithTest(t, "echo 'No tests defined'");
  assert.equal(bin(root, "sync", []).status, 0);
  assert.equal(testJob(root), "false");
});

test("an existing test-job: true sync wrote is turned off once the test script becomes a placeholder, where a sync that leaves any existing value keeps the wasted job", (t) => {
  const root = repoWithTest(t, "ajs module test");
  assert.equal(bin(root, "sync", []).status, 0);
  assert.equal(testJob(root), "true");
  put(
    root,
    "package.json",
    `${JSON.stringify({ name: "guardrails-test", type: "module", packageManager: "npm@11.0.0", scripts: { test: "echo no tests && exit 0" } }, null, 2)}\n`,
  );
  commit(root);
  assert.equal(bin(root, "sync", []).status, 0);
  assert.equal(testJob(root), "false");
  const check = bin(root, "sync", ["--check"]);
  assert.doesNotMatch(check.stdout + check.stderr, /ci\.yml/);
});

test("only echo and exit 0 make a placeholder; a real runner, a missing script or a command after the echo keep the test job, where a check for the word echo turns real tests off", () => {
  assert.equal(placeholderTestScript("echo 'No tests defined'"), true);
  assert.equal(
    placeholderTestScript('echo "Error: no test specified" && exit 0'),
    true,
  );
  assert.equal(placeholderTestScript(undefined), false);
  assert.equal(placeholderTestScript("ajs module test"), false);
  assert.equal(placeholderTestScript("echo building && node --test"), false);
  assert.equal(placeholderTestScript("exit 1"), false);
});
