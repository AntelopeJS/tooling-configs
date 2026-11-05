import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { bin, linkOxlint, put, read, testRepo } from "./helpers/test-repo.ts";

const TEMPLATE = ["--profile", "template"];
const SCAFFOLD_EXCLUDED_PATHS = [".agents", ".claude/skills"];

const MODULE_TEMPLATE_MANIFEST = `${JSON.stringify({ name: "template-module", type: "module", packageManager: "npm@11.0.0", antelopeJs: { implements: ["antelopejs-module"] } }, null, 2)}\n`;

function templateSource(t: TestContext, manifest?: string): string {
  const root = testRepo(t);
  if (manifest !== undefined) put(root, "package.json", manifest);
  const sync = bin(root, "sync", [...TEMPLATE, "--verify", "template"]);
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

test("the template source, marked by its verify-template skill, still fails the check on one drifted agent skill", (t) => {
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

test("the full profile still links verify-template from AGENTS.md, since only template scaffolds drop the agent layer", (t) => {
  const root = testRepo(t);
  linkOxlint(root);
  put(
    root,
    "oxlint.config.ts",
    'import type {} from "@antelopejs/tooling-configs/oxc/lint";\nexport default {};\n',
  );
  const sync = bin(root, "sync", ["--verify", "template"]);
  assert.equal(sync.status, 0, sync.stderr);
  assert.match(
    read(root, "AGENTS.md"),
    /\[`\.agents\/skills\/verify-template\/SKILL\.md`\]/,
  );
});
