import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

import type { OxlintConfig } from "oxlint";

import { antelopePreset } from "../oxc/lint.ts";
import { lockedRelease, PACK_NEW_RULES } from "./adoption.ts";
import { isPackRelease } from "./ceilings.ts";
import { commit, put, testRepo } from "./helpers/test-repo.ts";

/** Every rule the preset enabled at 0.2.16, before {@link PACK_NEW_RULES} existed. A rule added since belongs in PACK_NEW_RULES, never here. */
const RULES_BEFORE_REGISTRY = new Set([
  "antelopejs/no-comments",
  "antelopejs/no-constant-value-assertion",
  "antelopejs/no-fs-read-in-tests",
  "antelopejs/no-self-import-in-tests",
  "antelopejs/no-typeof-function-only-test",
  "antelopejs/require-assertion",
  "anti-slop/no-chained-type-assertions",
  "anti-slop/no-conditional-empty-object-spread",
  "anti-slop/no-known-value-widening",
  "anti-slop/no-module-mocking",
  "anti-slop/no-object-parameters",
  "anti-slop/no-reflect-apply",
  "anti-slop/no-reflect-get",
  "anti-slop/no-runtime-typeof",
  "anti-slop/no-shape-in-symbol-names",
  "anti-slop/no-unknown-parameters",
  "anti-slop/no-unknown-returns",
  "anti-slop/no-unknown-type-aliases",
  "anti-slop/no-unsafe-dictionary-type",
  "anti-slop/no-widen-then-assert",
  "anti-slop/require-safety-comment-for-type-assertion",
  "eslint/complexity",
  "eslint/eqeqeq",
  "eslint/max-depth",
  "eslint/max-lines",
  "eslint/max-lines-per-function",
  "eslint/max-params",
  "eslint/no-unused-vars",
  "eslint/prefer-regex-literals",
  "eslint/radix",
  "import/no-cycle",
  "import/no-duplicates",
  "import/no-self-import",
  "perfectionist/sort-imports",
  "typescript/await-thenable",
  "typescript/ban-ts-comment",
  "typescript/no-base-to-string",
  "typescript/no-floating-promises",
  "typescript/no-meaningless-void-operator",
  "typescript/no-misused-spread",
  "typescript/no-redundant-type-constituents",
  "typescript/require-array-sort-compare",
  "typescript/restrict-template-expressions",
  "typescript/unbound-method",
]);

function enabledRules(
  layer: OxlintConfig,
  found = new Set<string>(),
): Set<string> {
  for (const parent of layer.extends ?? []) enabledRules(parent, found);
  for (const rules of [
    layer.rules,
    ...(layer.overrides ?? []).map((override) => override.rules),
  ])
    for (const [rule, setting] of Object.entries(rules ?? {}))
      if ((Array.isArray(setting) ? setting[0] : setting) !== "off")
        found.add(rule);
  return found;
}

test("every rule the preset enables after 0.2.16 is listed in PACK_NEW_RULES with its release, so ratchet:update can adopt it", () => {
  const enabled = enabledRules(antelopePreset({ importSorting: true }));
  for (const rule of enabled)
    assert.ok(
      RULES_BEFORE_REGISTRY.has(rule) || PACK_NEW_RULES.has(rule),
      `${rule} is enabled by the preset but missing from PACK_NEW_RULES in src/guardrails/adoption.ts. Add it with the release after the version in package.json.`,
    );
  for (const [rule, release] of PACK_NEW_RULES) {
    assert.ok(
      enabled.has(rule),
      `${rule} is in PACK_NEW_RULES but the preset does not enable it.`,
    );
    assert.equal(RULES_BEFORE_REGISTRY.has(rule), false, rule);
    assert.ok(isPackRelease(release), `${rule}: ${release}`);
  }
});

test("the installed pack release is read from the root importer of a pnpm lockfile or from an npm lockfile", (t) => {
  const root = testRepo(t);
  put(
    root,
    "package-lock.json",
    JSON.stringify({
      packages: {
        "node_modules/@antelopejs/tooling-configs": { version: "0.2.16" },
      },
    }),
  );
  commit(root);
  assert.equal(lockedRelease(root, "HEAD"), "0.2.16");
  put(
    root,
    "pnpm-lock.yaml",
    "lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    devDependencies:\n      '@antelopejs/tooling-configs':\n        specifier: ^0.2.11\n        version: 0.2.11(oxlint@1.81.0)\n",
  );
  commit(root);
  assert.equal(lockedRelease(root, "HEAD"), "0.2.11");
  execFileSync("git", ["rm", "-q", "pnpm-lock.yaml", "package-lock.json"], {
    cwd: root,
  });
  commit(root);
  assert.equal(lockedRelease(root, "HEAD"), undefined);
});
