import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { formatCeilings } from "./ceilings.ts";
import { git, stage } from "./helpers/staged-ratchet-repo.ts";
import { bin, commit, linkOxlint, put, testRepo } from "./helpers/test-repo.ts";

const LEGACY = "export const keep = 0;\nexport const first: any = 1;\n";
const ADDED = `${LEGACY}export const second: any = 2;\nexport const third: any = 3;\n`;

function legacyRepo(t: TestContext): string {
  const root = testRepo(t);
  linkOxlint(root);
  put(
    root,
    ".oxlintrc.json",
    JSON.stringify({
      categories: { correctness: "off" },
      plugins: ["typescript"],
      rules: { "typescript/no-explicit-any": "error" },
    }),
  );
  put(root, "source.ts", LEGACY);
  put(
    root,
    "guardrails.ratchet.json",
    formatCeilings({
      rules: { "typescript/no-explicit-any": 1 },
      oversizeFiles: {},
    }),
  );
  commit(root);
  return root;
}

const DELETED_AFTER_STAGING: Record<string, (root: string) => string> = {
  "an added file (AD)": (root) => {
    put(root, "extra.ts", ADDED);
    stage(root, "extra.ts");
    return "extra.ts";
  },
  "a modified file (MD)": (root) => {
    put(root, "source.ts", ADDED);
    stage(root, "source.ts");
    return "source.ts";
  },
  "a renamed file (RD)": (root) => {
    git(root, "mv", "source.ts", "moved.ts");
    put(root, "moved.ts", ADDED);
    stage(root, "moved.ts");
    return "moved.ts";
  },
};

for (const [name, setUp] of Object.entries(DELETED_AFTER_STAGING))
  test(`staged ratchet fails findings in ${name} staged and then deleted in the working tree`, (t) => {
    const root = legacyRepo(t);
    const file = setUp(root);
    rmSync(join(root, file));
    const result = bin(root, "ratchet", ["--staged"]);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /no-explicit-any: this commit adds \d/u);
    assert.ok(result.stderr.includes(`\n  ${file}:3:`), result.stderr);
  });

test("staged ratchet measures the staged content, not a working copy that dropped the findings", (t) => {
  const root = legacyRepo(t);
  put(root, "source.ts", ADDED);
  stage(root, "source.ts");
  put(root, "source.ts", LEGACY);
  const result = bin(root, "ratchet", ["--staged", "source.ts"]);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /adds 2 to the staged files/u);
});

test("staged ratchet measures every staged file when the hook names only some", (t) => {
  const root = legacyRepo(t);
  put(root, "extra.ts", ADDED);
  put(root, "other.ts", "export const other = 0;\n");
  stage(root, "extra.ts", "other.ts");
  rmSync(join(root, "extra.ts"));
  const result = bin(root, "ratchet", ["--staged", "other.ts"]);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /extra\.ts:3:/u);
});
