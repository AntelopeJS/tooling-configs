import assert from "node:assert/strict";
import test from "node:test";

import {
  governanceDrift,
  nextGovernance,
  orgChecksRuleset,
} from "./checks/governance.ts";
import { FakeApi, fixture } from "./helpers/fake-api.ts";
import type { JsonValue } from "./json.ts";
import type { CheckResult } from "./types.ts";

function ruleset(
  overrides: { [key: string]: JsonValue },
  include = "refs/heads/next",
): JsonValue {
  return {
    id: 1,
    name: "Next branch",
    target: "branch",
    enforcement: "active",
    conditions: { ref_name: { include: [include], exclude: [] } },
    bypass_actors: [
      {
        actor_type: "RepositoryRole",
        actor_id: 5,
        bypass_mode: "pull_request",
      },
    ],
    rules: [
      {
        type: "required_status_checks",
        parameters: {
          required_status_checks: [
            { context: "ci / checks", integration_id: 15368 },
            { context: "verify-gate", integration_id: 15368 },
          ],
        },
      },
      {
        type: "pull_request",
        parameters: {
          required_approving_review_count: 0,
          allowed_merge_methods: ["squash"],
        },
      },
    ],
    ...overrides,
  };
}

function world(
  variable: string | undefined,
  sets: JsonValue[],
  people: JsonValue[] = [],
): FakeApi {
  const api = new FakeApi()
    .org([{ name: "mongodb", branch: "next" }])
    .repo("mongodb", { ".agents/skills/verification/SKILL.md": "" })
    .route(
      "/repos/AntelopeJS/mongodb/rulesets",
      sets.map((_set, index) => ({
        id: index + 1,
        enforcement: "active",
        target: "branch",
        source_type: "Repository",
      })),
    )
    .route("/repos/AntelopeJS/mongodb/collaborators", people);
  sets.forEach((set, index) =>
    api.route(`/repos/AntelopeJS/mongodb/rulesets/${index + 1}`, set),
  );
  if (variable !== undefined)
    api.route("/repos/AntelopeJS/mongodb/actions/variables/NEXT_AUTOMERGE", {
      value: variable,
    });
  return api;
}

function subjects(result: CheckResult): string[] {
  assert.equal(result.kind, "findings");
  return result.kind === "findings"
    ? result.findings.map(({ subject, severity }) => `${subject}:${severity}`)
    : [];
}

const MAIN = ruleset({ name: "Main" }, "~DEFAULT_BRANCH");

test("the repository checks stay skipped until the NEXT_AUTOMERGE variable exists somewhere", async () => {
  const result = await nextGovernance.run(
    world(undefined, [ruleset({}), MAIN]).context(),
  );
  assert.deepEqual(result, {
    kind: "skipped",
    reason:
      "NEXT_AUTOMERGE exists on no repository yet (the verify-gate task has not landed).",
  });
});

test("rulesets that follow the Next channel policy raise nothing", async () => {
  assert.deepEqual(
    subjects(
      await nextGovernance.run(world("off", [ruleset({}), MAIN]).context()),
    ),
    [],
  );
});

test("the live antelopejs next ruleset is drift: no verify-gate, a review rule, a role that bypasses always", async () => {
  const live = fixture("ruleset-next.json");
  const found = subjects(
    await nextGovernance.run(world("shadow", [live, MAIN]).context()),
  );
  assert.deepEqual(found, [
    "next:verify-gate:urgent",
    "next:review-rule:urgent",
    "next:bypass:urgent",
  ]);
});

test("squash-only and the checks context are normal drift, and the legacy checks context is still accepted", async () => {
  const merge = ruleset({
    rules: [
      {
        type: "required_status_checks",
        parameters: {
          required_status_checks: [
            { context: "checks", integration_id: 15368 },
            { context: "verify-gate", integration_id: 15368 },
          ],
        },
      },
      {
        type: "pull_request",
        parameters: {
          required_approving_review_count: 0,
          allowed_merge_methods: ["squash", "merge"],
        },
      },
    ],
  });
  assert.deepEqual(
    subjects(await nextGovernance.run(world("off", [merge, MAIN]).context())),
    ["next:squash-only:normal"],
  );
  const missing = ruleset({
    rules: [
      {
        type: "required_status_checks",
        parameters: {
          required_status_checks: [
            { context: "verify-gate", integration_id: 15368 },
          ],
        },
      },
      {
        type: "pull_request",
        parameters: {
          required_approving_review_count: 0,
          allowed_merge_methods: ["squash"],
        },
      },
    ],
  });
  assert.deepEqual(
    subjects(await nextGovernance.run(world("off", [missing, MAIN]).context())),
    ["next:checks:normal"],
  );
});

test("a required check from another app does not count as GitHub Actions", async () => {
  const foreign = ruleset({
    rules: [
      {
        type: "required_status_checks",
        parameters: {
          required_status_checks: [
            { context: "ci / checks", integration_id: 1 },
            { context: "verify-gate", integration_id: 1 },
          ],
        },
      },
      {
        type: "pull_request",
        parameters: {
          required_approving_review_count: 0,
          allowed_merge_methods: ["squash"],
        },
      },
    ],
  });
  assert.deepEqual(
    subjects(await nextGovernance.run(world("off", [foreign, MAIN]).context())),
    ["next:verify-gate:urgent", "next:checks:normal"],
  );
});

test("only Antony, Maxime and Damir may hold admin, and altabmachine holds no maintain", async () => {
  const people = [
    { login: "Upd4ting", role_name: "admin" },
    { login: "mwesto", role_name: "admin" },
    { login: "dada-sudo", role_name: "admin" },
    { login: "Glastis", role_name: "admin" },
    { login: "altabmachine", role_name: "maintain" },
    { login: "alessaloisio", role_name: "write" },
  ];
  const found = subjects(
    await nextGovernance.run(
      world("off", [ruleset({}), MAIN], people).context(),
    ),
  );
  assert.deepEqual(found, [
    "admin:Glastis:normal",
    "maintain:altabmachine:normal",
  ]);
});

test("NEXT_AUTOMERGE=on needs an N1 or N2 repository with a Verification skill", async () => {
  assert.deepEqual(
    subjects(
      await nextGovernance.run(world("on", [ruleset({}), MAIN]).context()),
    ),
    [],
  );
  const noSkill = world("on", [ruleset({}), MAIN]).repo("mongodb", {});
  assert.deepEqual(subjects(await nextGovernance.run(noSkill.context())), [
    "automerge-scope:normal",
  ]);
  const n3 = world("on", [ruleset({}), MAIN]).org([
    { name: "mongodb", tier: "N3", branch: "next" },
  ]);
  assert.deepEqual(subjects(await nextGovernance.run(n3.context())), [
    "automerge-scope:normal",
  ]);
});

test("an organization owner outside the allowed three is drift, the three themselves are not", async () => {
  const clean = new FakeApi().route("/orgs/AntelopeJS/members", [
    { login: "Upd4ting" },
    { login: "mwesto" },
    { login: "dada-sudo" },
  ]);
  assert.deepEqual(subjects(await governanceDrift.run(clean.context())), []);
  const extra = new FakeApi().route("/orgs/AntelopeJS/members", [
    { login: "Upd4ting" },
    { login: "Glastis" },
  ]);
  assert.deepEqual(subjects(await governanceDrift.run(extra.context())), [
    "org-admin:Glastis:normal",
  ]);
});

test("the org checks ruleset is postponed, not drift", async () => {
  assert.deepEqual(await orgChecksRuleset.run(new FakeApi().context()), {
    kind: "skipped",
    reason: "ruleset postponed until the sync fan-out",
  });
});
