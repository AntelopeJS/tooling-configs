import assert from "node:assert/strict";
import test from "node:test";

import { bin, linkOxlint, put, testRepo } from "./helpers/test-repo.ts";

test("sync measures zero diagnostics in a repository with no lintable file, where parsing oxlint's stdout whole crashed on its no-files notice", (t) => {
  const root = testRepo(t);
  linkOxlint(root);
  put(
    root,
    "oxlint.config.ts",
    'import type {} from "@antelopejs/tooling-configs/oxc/lint";\nexport default { ignorePatterns: ["oxlint.config.ts"] };\n',
  );
  const result = bin(root, "sync");
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /Unexpected token/);
  assert.equal(bin(root, "sync", ["--check"]).status, 0);
});
