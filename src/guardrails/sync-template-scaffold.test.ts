import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { bin, markTemplateSource, put, testRepo } from "./helpers/test-repo.ts";

const TEMPLATE = ["--profile", "template"];
const SCAFFOLD_EXCLUDED_PATHS = [".agents", ".claude/skills"];

const MODULE_TEMPLATE_MANIFEST = `${JSON.stringify({ name: "template-module", type: "module", packageManager: "npm@11.0.0", antelopeJs: { implements: ["antelopejs-module"] } }, null, 2)}\n`;

function templateSource(t: TestContext, manifest?: string): string {
  const root = testRepo(t);
  markTemplateSource(root);
  if (manifest !== undefined) put(root, "package.json", manifest);
  const sync = bin(root, "sync", TEMPLATE);
  assert.equal(sync.status, 0, sync.stderr);
  return root;
}

for (const [label, manifest] of [
  ["a plain template", undefined],
  [
    "a module template, whose package.json implements an interface",
    MODULE_TEMPLATE_MANIFEST,
  ],
] as const)
  test(`a project scaffolded from ${label}, which core ships without the agent layer, passes the template sync check`, (t) => {
    const root = templateSource(t, manifest);
    for (const path of SCAFFOLD_EXCLUDED_PATHS)
      rmSync(join(root, path), { recursive: true, force: true });
    const check = bin(root, "sync", [...TEMPLATE, "--check"]);
    assert.equal(check.status, 0, check.stdout);
    assert.equal(check.stdout, "Guardrails are in sync.\n");
  });

test("the template source, marked by its `.agents/` folder, still fails the check on one drifted agent skill", (t) => {
  const root = templateSource(t);
  assert.equal(bin(root, "sync", [...TEMPLATE, "--check"]).status, 0);
  put(root, ".agents/skills/unslop/SKILL.md", "Hand edited.\n");
  const check = bin(root, "sync", [...TEMPLATE, "--check"]);
  assert.equal(check.status, 1);
  assert.equal(
    check.stdout,
    "Drift: .agents/skills/unslop/SKILL.md; run antelopejs-sync\n",
  );
});

test("the template source still fails the check when one of its writing skills alone is deleted", (t) => {
  const root = templateSource(t);
  rmSync(join(root, ".agents/skills/unslop/SKILL.md"));
  const check = bin(root, "sync", [...TEMPLATE, "--check"]);
  assert.equal(check.status, 1);
  assert.equal(
    check.stdout,
    "Drift: .agents/skills/unslop/SKILL.md; run antelopejs-sync\n",
  );
});
