import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { syncRepository } from "./sync.ts";
import { bin, linkOxlint, put, read, testRepo } from "./helpers/test-repo.ts";

/** Renovate's config lookup order, kept literal so a path dropped from the pack's list fails here. */
const RENOVATE_CONFIGS = [
  "renovate.json",
  "renovate.jsonc",
  "renovate.json5",
  ".github/renovate.json",
  ".github/renovate.jsonc",
  ".github/renovate.json5",
  ".gitlab/renovate.json",
  ".gitlab/renovate.jsonc",
  ".gitlab/renovate.json5",
  ".renovaterc",
  ".renovaterc.json",
  ".renovaterc.jsonc",
  ".renovaterc.json5",
];
const PRESET = "github>AntelopeJS/.github:renovate.json5";
const TEMPLATE_SOURCE = { profile: "template", verify: "template" } as const;

const PROFILES: [string, string[]][] = [
  ["a full-profile repository", []],
  ["a template source", ["--profile", "template", "--verify", "template"]],
];

for (const [label, args] of PROFILES)
  test(`--check fails ${label} without a Renovate config, and sync writes one extending the AntelopeJS preset`, (t) => {
    const root = testRepo(t);
    linkOxlint(root);
    put(
      root,
      "oxlint.config.ts",
      'import type {} from "@antelopejs/tooling-configs/oxc/lint";\nexport default {};\n',
    );
    const before = bin(root, "sync", [...args, "--check"]);
    assert.equal(before.status, 1, before.stderr);
    assert.match(
      before.stdout,
      /^Drift: renovate\.json; run antelopejs-sync$/m,
    );
    const sync = bin(root, "sync", args);
    assert.equal(sync.status, 0, sync.stderr);
    assert.deepEqual(JSON.parse(read(root, "renovate.json")).extends, [PRESET]);
    const after = bin(root, "sync", [...args, "--check"]);
    assert.doesNotMatch(after.stdout + after.stderr, /renovate/);
  });

test("a project scaffolded from a template neither gets nor needs a renovate.json", (t) => {
  const root = testRepo(t);
  const result = syncRepository(root, { profile: "template" });
  assert.ok(!result.paths.includes("renovate.json"));
  assert.deepEqual(result.errors, []);
  assert.equal(existsSync(join(root, "renovate.json")), false);
});

test("sync keeps a hand-tuned renovate.json on the preset byte for byte", (t) => {
  const root = testRepo(t);
  const tuned = `{ "extends": ["${PRESET}"], "schedule": ["before 6am"] }\n`;
  put(root, "renovate.json", tuned);
  const result = syncRepository(root, TEMPLATE_SOURCE);
  assert.deepEqual(result.errors, []);
  assert.ok(!result.paths.includes("renovate.json"));
  assert.equal(read(root, "renovate.json"), tuned);
});

for (const path of RENOVATE_CONFIGS)
  test(`sync and --check fail a ${path} off the AntelopeJS preset and leave it as it is`, (t) => {
    const root = testRepo(t);
    const own = '{ "extends": ["config:recommended"] }\n';
    put(root, path, own);
    for (const check of [true, false]) {
      const result = syncRepository(root, { ...TEMPLATE_SOURCE, check });
      assert.equal(result.errors.length, 1);
      assert.match(
        result.errors[0],
        new RegExp(`^${path.replace(/\./g, "\\.")}: extend "${PRESET}"`),
      );
    }
    assert.equal(read(root, path), own);
  });

for (const path of RENOVATE_CONFIGS.slice(1))
  test(`sync writes no renovate.json beside a preset config at ${path}, which Renovate would read second`, (t) => {
    const root = testRepo(t);
    put(root, path, `{ extends: ["${PRESET}"] }\n`);
    const result = syncRepository(root, TEMPLATE_SOURCE);
    assert.deepEqual(result.errors, []);
    assert.ok(!result.paths.includes("renovate.json"));
    assert.equal(existsSync(join(root, "renovate.json")), false);
  });

test("a renovate key in package.json counts as the config", (t) => {
  const root = testRepo(t);
  put(
    root,
    "package.json",
    `${JSON.stringify({ name: "x", type: "module", packageManager: "npm@11.0.0", renovate: { extends: ["config:recommended"] } })}\n`,
  );
  const result = syncRepository(root, TEMPLATE_SOURCE);
  assert.deepEqual(result.errors, [
    `package.json "renovate": extend "${PRESET}" in its extends, then rerun antelopejs-sync.`,
  ]);
  assert.equal(existsSync(join(root, "renovate.json")), false);
});

test("a falsy renovate key in package.json counts as no config, as Renovate reads it", (t) => {
  const root = testRepo(t);
  put(
    root,
    "package.json",
    `${JSON.stringify({ name: "x", type: "module", packageManager: "npm@11.0.0", renovate: null })}\n`,
  );
  const result = syncRepository(root, TEMPLATE_SOURCE);
  assert.deepEqual(result.errors, []);
  assert.ok(result.paths.includes("renovate.json"));
});
