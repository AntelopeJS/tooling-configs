import assert from "node:assert/strict";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import type { TestContext } from "node:test";
import test from "node:test";

import { parseManifest } from "./package.ts";
import { writeTool } from "./helpers/shell.ts";
import { bin, commit, put, read, testRepo } from "./helpers/test-repo.ts";

const INTERFACE = "@antelopejs/interface-dms-marketing";
const MODULE_MANIFEST = "packages/dms-marketing/package.json";

/** A pnpm on PATH that records each call's real directory and arguments, then succeeds or fails as `exitCode` says. */
function recordingPnpm(t: TestContext, exitCode = 0) {
  const directory = mkdtempSync(join(tmpdir(), "antelope-pnpm-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const log = join(directory, "calls.log");
  writeTool(
    directory,
    "pnpm",
    `const fs = require("node:fs");\nfs.appendFileSync(${JSON.stringify(log)}, [fs.realpathSync.native(process.cwd()), ...process.argv.slice(2)].join(" ") + "\\n");\nprocess.exit(${exitCode});`,
  );
  return {
    env: { PATH: `${directory}${delimiter}${process.env.PATH ?? ""}` },
    calls: (): string[] =>
      existsSync(log) ? read(directory, "calls.log").trim().split("\n") : [],
  };
}

/** A pnpm workspace whose module implements the interface beside it, released at `interfaceVersion`. */
function workspace(
  t: TestContext,
  interfaceVersion: string,
  packageManager = "pnpm@10.33.0",
): string {
  const root = testRepo(t);
  put(
    root,
    "package.json",
    `${JSON.stringify({ name: "dms-marketing-workspace", private: true, type: "module", packageManager }, null, 2)}\n`,
  );
  put(
    root,
    "guardrails.ratchet.json",
    '{"rules":{"eslint/no-alert":1},"oversizeFiles":{}}\n',
  );
  put(root, "pnpm-workspace.yaml", "packages:\n  - packages/*\n");
  put(root, "pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
  put(
    root,
    "packages/interface-dms-marketing/package.json",
    `${JSON.stringify({ name: INTERFACE, version: interfaceVersion }, null, 2)}\n`,
  );
  put(
    root,
    MODULE_MANIFEST,
    `${JSON.stringify(
      {
        name: "@antelopejs/dms-marketing",
        version: "0.9.2",
        dependencies: {
          "@antelopejs/interface-dms": ">=0.12.0 <1.0.0",
          [INTERFACE]: ">=0.6.0 <0.7.0",
        },
        antelopeJs: { implements: [INTERFACE] },
      },
      null,
      2,
    )}\n`,
  );
  commit(root);
  return root;
}

function moduleRange(root: string): string | undefined {
  return parseManifest(read(root, MODULE_MANIFEST)).dependencies?.[INTERFACE];
}

test("sync moves a module's range to the next minor of the interface released beside it and relocks with pnpm, where a sync that leaves the range fails antelopejs-check-interface-ranges on the release commit and one that skips the relock fails CI's frozen install", (t) => {
  const root = workspace(t, "0.7.0");
  const pnpm = recordingPnpm(t);
  const result = bin(root, "sync", [], pnpm.env);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.equal(moduleRange(root), ">=0.7.0 <0.8.0");
  assert.equal(
    parseManifest(read(root, MODULE_MANIFEST)).dependencies?.[
      "@antelopejs/interface-dms"
    ],
    ">=0.12.0 <1.0.0",
  );
  assert.match(
    result.stdout,
    /Updated: packages\/dms-marketing\/package\.json/,
  );
  assert.deepEqual(pnpm.calls(), [
    `${realpathSync.native(root)} install --lockfile-only`,
  ]);
  const check = bin(root, "check-interface-ranges");
  assert.equal(check.status, 0, check.stderr);
});

test("sync writes the module's docs-compat table from the moved range, where a sync that plans the README before moving the range leaves sync --check failing on the release commit", (t) => {
  const root = workspace(t, "0.7.0");
  const pnpm = recordingPnpm(t);
  const result = bin(root, "sync", [], pnpm.env);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(
    read(root, "packages/dms-marketing/README.md"),
    /`@antelopejs\/interface-dms-marketing` \| `>=0\.7\.0 <0\.8\.0`/,
  );
  const check = bin(root, "sync", ["--check"], pnpm.env);
  assert.equal(check.status, 0, check.stdout + check.stderr);
});

test("sync leaves a module's range and lockfile alone after a patch release of its interface, where a sync that moves the floor to every release or relocks on each run rewrites files the release did not change", (t) => {
  const root = workspace(t, "0.6.2");
  const pnpm = recordingPnpm(t);
  const result = bin(root, "sync", [], pnpm.env);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.equal(moduleRange(root), ">=0.6.0 <0.7.0");
  assert.deepEqual(pnpm.calls(), []);
});

test("sync --check reports the stale range as drift without writing or installing, where a check that rewrites files or runs pnpm changes the tree it only inspects", (t) => {
  const root = workspace(t, "0.7.0");
  const pnpm = recordingPnpm(t);
  const result = bin(root, "sync", ["--check"], pnpm.env);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /Drift: packages\/dms-marketing\/package\.json/);
  assert.equal(moduleRange(root), ">=0.6.0 <0.7.0");
  assert.deepEqual(pnpm.calls(), []);
});

test("sync fails, names the manifest and leaves its range unmoved when the relock fails, where a sync that keeps the moved range passes on its next run with a lockfile CI's frozen install refuses", (t) => {
  const root = workspace(t, "0.7.0");
  const failing = recordingPnpm(t, 1);
  const result = bin(root, "sync", [], failing.env);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(
    result.stderr,
    /Left the interface ranges in packages\/dms-marketing\/package\.json unmoved: the lockfile could not follow them\. pnpm install --lockfile-only failed \(exit 1\)/,
  );
  assert.equal(moduleRange(root), ">=0.6.0 <0.7.0");
  const pnpm = recordingPnpm(t);
  const retry = bin(root, "sync", [], pnpm.env);
  assert.equal(retry.status, 0, retry.stderr + retry.stdout);
  assert.deepEqual(pnpm.calls(), [
    `${realpathSync.native(root)} install --lockfile-only`,
  ]);
});

test("sync leaves a range it does not own: an implemented interface published from another repository and a sibling that only consumes the local interface, where a sync that drops either filter rewrites them and relocks from npm", (t) => {
  const root = workspace(t, "0.6.2");
  const outsider = {
    name: "@antelopejs/dms-marketing-extra",
    version: "0.1.0",
    dependencies: {
      "@antelopejs/interface-database": "^0.3.0",
      [INTERFACE]: "^0.6.0",
    },
    antelopeJs: { implements: ["@antelopejs/interface-database"] },
  };
  const text = `${JSON.stringify(outsider, null, 2)}\n`;
  put(root, "packages/extra/package.json", text);
  commit(root);
  const pnpm = recordingPnpm(t);
  const result = bin(root, "sync", [], pnpm.env);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.equal(read(root, "packages/extra/package.json"), text);
  assert.deepEqual(pnpm.calls(), []);
});

test("sync refuses to move a range in a repository it cannot relock with pnpm and leaves the manifest as it was, where a sync that writes it leaves an npm lockfile its install refuses", (t) => {
  const root = workspace(t, "0.7.0", "npm@11.0.0");
  const pnpm = recordingPnpm(t);
  const result = bin(root, "sync", [], pnpm.env);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /npm is not pnpm, so sync cannot relock them/);
  assert.equal(moduleRange(root), ">=0.6.0 <0.7.0");
  assert.deepEqual(pnpm.calls(), []);
});
