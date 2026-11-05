import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { bin, put, testRepo } from "./helpers/test-repo.ts";

const TEMPLATE = ["--profile", "template"];
const SCAFFOLD_EXCLUDED_PATHS = [".agents", ".claude/skills"];

function templateSource(t: TestContext): string {
  const root = testRepo(t);
  const sync = bin(root, "sync", [...TEMPLATE, "--verify", "template"]);
  assert.equal(sync.status, 0, sync.stderr);
  return root;
}

test("a project scaffolded from a template, which core ships without the agent layer, passes the template sync check", (t) => {
  const root = templateSource(t);
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
