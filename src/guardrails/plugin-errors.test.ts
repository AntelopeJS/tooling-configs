import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import { formatCeilings } from "./ceilings.ts";
import { formatBudget } from "./suppression-budget.ts";
import { bin, commit, linkOxlint, put, testRepo } from "./helpers/test-repo.ts";

const THROWING_PLUGIN = [
  "export default {",
  '  meta: { name: "boom" },',
  "  rules: {",
  "    explode: {",
  "      create() {",
  "        return {",
  "          Program() {",
  '            throw new Error("explode rule crashed");',
  "          },",
  "        };",
  "      },",
  "    },",
  "  },",
  "};",
  "",
].join("\n");

const SOURCE = [
  "// oxlint-disable-next-line eslint/no-debugger -- the probe pauses here",
  "debugger;",
  "export const value = 1;",
  "",
].join("\n");

/** A repository whose only JS plugin rule throws on every file it lints, with `sample.ts` and its directive edited since the last commit. */
function crashingRepo(t: TestContext): string {
  const root = testRepo(t);
  linkOxlint(root);
  put(root, "boom.mjs", THROWING_PLUGIN);
  put(
    root,
    ".oxlintrc.json",
    JSON.stringify({
      categories: { correctness: "off" },
      ignorePatterns: ["boom.mjs"],
      jsPlugins: ["./boom.mjs"],
      rules: { "boom/explode": "error", "eslint/no-debugger": "error" },
    }),
  );
  put(
    root,
    "guardrails.ratchet.json",
    formatCeilings({ rules: { "boom/explode": 0 }, oversizeFiles: {} }),
  );
  put(
    root,
    "guardrails.suppressions.json",
    formatBudget({
      rules: { "eslint/no-debugger": 1 },
      tsExpectError: 0,
      tsIgnore: 0,
      safety: 0,
    }),
  );
  put(root, "sample.ts", SOURCE);
  commit(root);
  put(root, "sample.ts", `${SOURCE}export const touched = 2;\n`);
  return root;
}

const CHECKS: [string, string[]][] = [
  ["body-check", ["--findings"]],
  ["ratchet", []],
  ["suppressions", []],
];

for (const [name, args] of CHECKS)
  test(`${name} prints the JS plugin's error and stack when a plugin rule throws`, (t) => {
    const root = crashingRepo(t);
    const result = bin(root, name, args);
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, /Error running JS plugin\./u);
    assert.match(result.stderr, /Error: explode rule crashed\n\s+at Program /u);
    assert.doesNotMatch(
      result.stderr,
      /Cannot measure oxlint diagnostic code/u,
    );
  });
