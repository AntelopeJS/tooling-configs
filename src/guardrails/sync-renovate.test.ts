import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { RENOVATE_JSON } from "./renovate.ts";
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
    assert.equal(read(root, "renovate.json"), RENOVATE_JSON);
    const after = bin(root, "sync", [...args, "--check"]);
    assert.doesNotMatch(after.stdout, /renovate/);
  });

test("sync keeps a hand-tuned renovate.json as it is", (t) => {
  const root = testRepo(t);
  const tuned =
    '{ "extends": ["github>AntelopeJS/.github:renovate.json5"], "schedule": ["before 6am"] }\n';
  put(root, "renovate.json", tuned);
  const result = syncRepository(root, { profile: "template" });
  assert.ok(!result.paths.includes("renovate.json"));
  assert.equal(read(root, "renovate.json"), tuned);
});

test("sync writes no renovate.json beside a Renovate config at another path", (t) => {
  const root = testRepo(t);
  put(
    root,
    ".github/renovate.json5",
    '{ extends: ["github>AntelopeJS/.github:renovate.json5"] }\n',
  );
  const check = syncRepository(root, { check: true, profile: "template" });
  assert.ok(!check.paths.includes("renovate.json"));
  syncRepository(root, { profile: "template" });
  assert.equal(existsSync(join(root, "renovate.json")), false);
});
