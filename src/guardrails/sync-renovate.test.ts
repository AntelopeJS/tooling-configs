import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { RENOVATE_CONFIGS, RENOVATE_PATH } from "./renovate.ts";
import { syncRepository } from "./sync.ts";
import { bin, linkOxlint, put, read, testRepo } from "./helpers/test-repo.ts";

for (const profile of ["full", "template"] as const)
  test(`under the ${profile} profile, --check fails a repository without a Renovate config and sync writes one extending the AntelopeJS preset`, (t) => {
    const root = testRepo(t);
    linkOxlint(root);
    put(
      root,
      "oxlint.config.ts",
      'import type {} from "@antelopejs/tooling-configs/oxc/lint";\nexport default {};\n',
    );
    const args = ["--profile", profile];
    const before = bin(root, "sync", [...args, "--check"]);
    assert.equal(before.status, 1, before.stderr);
    assert.match(
      before.stdout,
      /^Drift: renovate\.json; run antelopejs-sync$/m,
    );
    const sync = bin(root, "sync", args);
    assert.equal(sync.status, 0, sync.stderr);
    assert.deepEqual(JSON.parse(read(root, "renovate.json")).extends, [
      "github>AntelopeJS/.github:renovate.json5",
    ]);
    const after = bin(root, "sync", [...args, "--check"]);
    assert.doesNotMatch(after.stdout, /renovate/);
  });

test("sync keeps an existing renovate.json as it is, even one off the AntelopeJS preset, which garden conformance reports", (t) => {
  const root = testRepo(t);
  const tuned =
    '{ "extends": ["config:recommended"], "schedule": ["before 6am"] }\n';
  put(root, "renovate.json", tuned);
  const result = syncRepository(root, { profile: "template" });
  assert.ok(!result.paths.includes("renovate.json"));
  assert.equal(read(root, "renovate.json"), tuned);
});

for (const path of RENOVATE_CONFIGS.filter((file) => file !== RENOVATE_PATH))
  test(`sync writes no renovate.json beside a Renovate config at ${path}`, (t) => {
    const root = testRepo(t);
    put(
      root,
      path,
      '{ extends: ["github>AntelopeJS/.github:renovate.json5"] }\n',
    );
    const check = syncRepository(root, { check: true, profile: "template" });
    assert.ok(!check.paths.includes("renovate.json"));
    syncRepository(root, { profile: "template" });
    assert.equal(existsSync(join(root, "renovate.json")), false);
  });
