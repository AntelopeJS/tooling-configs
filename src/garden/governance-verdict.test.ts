import assert from "node:assert/strict";
import test from "node:test";

import { branchGovernance, orgChecksRuleset } from "./checks/governance.ts";
import { FakeApi } from "./helpers/fake-api.ts";
import type { JsonObject } from "./json.ts";
import type { CheckResult } from "./types.ts";

const ACTIONS_APP = 15368;
const ADMIN = {
  actor_type: "RepositoryRole",
  actor_id: 5,
  bypass_mode: "pull_request",
};

function requiring(
  contexts: readonly string[],
  integration_id = ACTIONS_APP,
): JsonObject {
  return {
    type: "required_status_checks",
    parameters: {
      required_status_checks: contexts.map((context) => ({
        context,
        integration_id,
      })),
    },
  };
}

function branchWorld(checks: JsonObject): FakeApi {
  const rules = [
    "deletion",
    "non_fast_forward",
    "required_linear_history",
    "pull_request",
    "merge_queue",
  ].map((type) => ({ type, parameters: {} }));
  return new FakeApi()
    .org([{ name: "mongodb" }])
    .route(
      "/repos/AntelopeJS/mongodb/rules/branches/main",
      [...rules, checks].map((rule) => ({
        ...rule,
        ruleset_source_type: "Organization",
        ruleset_source: "AntelopeJS",
        ruleset_id: 1,
      })),
    )
    .route("/repos/AntelopeJS/mongodb/rulesets/1", {
      id: 1,
      name: "Default branch protection",
      bypass_actors: [ADMIN],
    });
}

function orgWorld(checks: JsonObject): FakeApi {
  const sets: JsonObject[] = [
    {
      id: 1,
      name: "Default branch protection",
      target: "branch",
      enforcement: "active",
      conditions: {
        ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] },
        repository_name: { include: ["~ALL"], exclude: ["k8s-gitops-infra"] },
      },
      rules: [],
    },
    {
      id: 2,
      name: "Required CI",
      target: "branch",
      enforcement: "active",
      conditions: {
        ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] },
        repository_property: {
          include: [
            {
              name: "pack",
              source: "custom",
              property_values: ["full", "template"],
            },
          ],
          exclude: [],
        },
      },
      rules: [checks],
    },
  ];
  const api = new FakeApi().route(
    "/orgs/AntelopeJS/rulesets",
    sets.map(({ id, name }) => ({ id, name })),
  );
  for (const set of sets)
    api.route(`/orgs/AntelopeJS/rulesets/${String(set.id)}`, set);
  return api;
}

function subjects(result: CheckResult): string[] {
  assert.equal(result.kind, "findings");
  return result.kind === "findings"
    ? result.findings.map(({ subject }) => subject)
    : [];
}

const ACCEPTED = [["verdict"], ["ci / checks"], ["verdict", "ci / checks"]];

test("a default branch that requires verdict, ci / checks or both from GitHub Actions meets the check, where one that accepts only ci / checks reports a branch that moved to verdict", async () => {
  for (const contexts of ACCEPTED)
    assert.deepEqual(
      subjects(
        await branchGovernance.run(branchWorld(requiring(contexts)).context()),
      ),
      [],
      contexts.join(),
    );
});

test("a required verdict from another app or another required context does not meet the check, where one that matches any context lets a foreign status gate the branch", async () => {
  for (const checks of [requiring(["verdict"], 1), requiring(["checks"])])
    assert.deepEqual(
      subjects(await branchGovernance.run(branchWorld(checks).context())),
      ["main:checks"],
    );
});

test("Required CI that requires verdict, ci / checks or both raises nothing, where a check that accepts only ci / checks flags the ruleset switch to verdict as drift", async () => {
  for (const contexts of ACCEPTED)
    assert.deepEqual(
      subjects(
        await orgChecksRuleset.run(orgWorld(requiring(contexts)).context()),
      ),
      [],
      contexts.join(),
    );
});
