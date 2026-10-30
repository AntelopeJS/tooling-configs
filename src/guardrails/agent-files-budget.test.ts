import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

import { generatedOutput } from "./files.ts";
import { syncRepository } from "./sync.ts";
import { syncedAgentPaths } from "../verify/kinds.ts";
import {
  bin,
  commit,
  linkOxlint,
  put,
  read,
  testRepo,
  usePreset,
} from "./helpers/test-repo.ts";

/** Reduced from dms `.agents/probes/dms-dev.cjs`, which starts the dev server from positional handles, with the directive an agent adds to silence the parameter limit. */
const DMS_PROBE = `const { resolve } = require("node:path");

// oxlint-disable-next-line eslint/max-params -- the probe takes the dev server handles positionally
function start(host, port, root, logs, env, cwd) {
  return resolve(root, host, port, logs, env, cwd);
}
module.exports = { start };
`;

/** Reduced from dms `.agents/skills/verify-dms/journeys/settings-roles.mjs`, a journey the repository wrote under a skill folder. */
const DMS_JOURNEY = `export async function journey(page) {
  // oxlint-disable-next-line eslint/no-debugger -- the journey pauses here for a headed run
  debugger;
  return page.goto("/settings/roles");
}
`;

const SYNCED_SKILL = `---
name: verify-module
---

// oxlint-disable-next-line eslint/max-params -- an example the skill shows
`;

const LEGACY_BUDGET = `${JSON.stringify(
  {
    rules: { "eslint/max-params": 0, "eslint/no-debugger": 0 },
    tsExpectError: 0,
    tsIgnore: 0,
    safety: 0,
    config: {},
  },
  null,
  2,
)}\n`;

function git(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function agentRepo(t: Parameters<typeof testRepo>[0], budget: string): string {
  const root = testRepo(t);
  put(root, ".agents/probes/dms-dev.cjs", DMS_PROBE);
  put(root, ".agents/skills/verify-module/journeys/roles.mjs", DMS_JOURNEY);
  put(
    root,
    "package.json",
    '{\n  "name": "budget", "scripts": { "sync:check": "x" }\n}\n',
  );
  put(root, "guardrails.suppressions.json", budget);
  commit(root);
  return root;
}

test("dms .agents/probes: a directive in a repository-authored agent file counts against a budget that records agent files", (t) => {
  const root = agentRepo(
    t,
    LEGACY_BUDGET.replace("\n}\n", ',\n  "agentFiles": true\n}\n'),
  );
  const result = bin(root, "suppressions");
  assert.equal(result.status, 1, result.stderr);
  assert.match(
    result.stderr,
    /lint rule `eslint\/max-params`: 1 exceeds ceiling 0\.\n {2}\.agents\/probes\/dms-dev\.cjs:3/,
  );
  assert.match(
    result.stderr,
    /lint rule `eslint\/no-debugger`: 1 exceeds ceiling 0\.\n {2}\.agents\/skills\/verify-module\/journeys\/roles\.mjs:2/,
  );
});

test("a directive in a file sync writes under .agents stays uncounted, and generatedOutput skips exactly the files sync writes", (t) => {
  const root = testRepo(t);
  put(root, ".agents/skills/verify-module/SKILL.md", SYNCED_SKILL);
  put(root, "guardrails.suppressions.json", LEGACY_BUDGET);
  commit(root);
  assert.equal(bin(root, "suppressions").status, 0);
  const skipped = generatedOutput(root);
  assert.deepEqual(
    syncedAgentPaths().filter((path) => !skipped(path)),
    [],
  );
  assert.equal(skipped(".agents/skills/verify-module/verify.config.ts"), false);
  assert.equal(skipped(".agents/probes/dms-dev.cjs"), false);
  assert.equal(skipped(".claude/skills/verify-dms/journey.mjs"), false);
});

test("sync adopts the agent files' directives into an existing budget at today's counts, so upgrading fails nothing and only additions fail", (t) => {
  const root = agentRepo(t, LEGACY_BUDGET);
  const legacy = git(root, ["rev-parse", "HEAD"]);
  const legacyRun = bin(root, "suppressions");
  assert.equal(legacyRun.status, 0, legacyRun.stderr);
  const synced = syncRepository(root);
  assert.deepEqual(synced.errors, []);
  const budget = JSON.parse(read(root, "guardrails.suppressions.json"));
  assert.equal(budget.agentFiles, true);
  assert.equal(budget.rules["eslint/max-params"], 1);
  assert.equal(budget.rules["eslint/no-debugger"], 1);
  assert.equal(syncRepository(root, { check: true }).paths.length, 0);
  commit(root);
  const adopted = bin(root, "suppressions", ["--base", legacy]);
  assert.equal(adopted.status, 0, adopted.stderr);
  linkOxlint(root);
  usePreset(root);
  put(root, ".agents/probes/second.cjs", DMS_PROBE.replace("start", "restart"));
  const added = bin(root, "suppressions");
  assert.equal(added.status, 1);
  assert.match(
    added.stderr,
    /eslint\/max-params`: 2 exceeds ceiling 1\.\n {2}\.agents\/probes\/second\.cjs:3/,
  );
});

test("adoption raises a ceiling by the agent files' count and no more: a hand raise above it fails against the base", (t) => {
  const root = agentRepo(t, LEGACY_BUDGET);
  const legacy = git(root, ["rev-parse", "HEAD"]);
  syncRepository(root);
  put(
    root,
    "guardrails.suppressions.json",
    read(root, "guardrails.suppressions.json").replace(
      '"eslint/max-params": 1',
      '"eslint/max-params": 2',
    ),
  );
  commit(root);
  const raised = bin(root, "suppressions", ["--base", legacy]);
  assert.equal(raised.status, 1);
  assert.match(
    raised.stderr,
    /raises lint rule `eslint\/max-params` from 0 on the base to 2, above the 1 that recording the agent files allows\./,
  );
});
