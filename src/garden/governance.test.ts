import assert from "node:assert/strict";
import test from "node:test";

import {
  branchGovernance,
  governanceDrift,
  orgChecksRuleset,
} from "./checks/governance.ts";
import { FakeApi } from "./helpers/fake-api.ts";
import type { JsonObject, JsonValue } from "./json.ts";
import type { CheckResult } from "./types.ts";

const ADMIN = {
  actor_type: "RepositoryRole",
  actor_id: 5,
  bypass_mode: "always",
};
const MAINTAIN = {
  actor_type: "RepositoryRole",
  actor_id: 2,
  bypass_mode: "always",
};
const CI_CHECKS = [{ context: "ci / checks", integration_id: 15368 }];
const CI_RULE = {
  type: "required_status_checks",
  parameters: { required_status_checks: CI_CHECKS },
};

function rule(
  type: string,
  id: number,
  source: "Organization" | "Repository" = "Organization",
  parameters: JsonObject = {},
): JsonObject {
  return {
    type,
    parameters,
    ruleset_source_type: source,
    ruleset_source:
      source === "Organization" ? "AntelopeJS" : "AntelopeJS/mongodb",
    ruleset_id: id,
  };
}

function ciRule(checks: JsonValue[] = CI_CHECKS): JsonObject {
  return rule("required_status_checks", 2, "Organization", {
    required_status_checks: checks,
  });
}

const PROTECTED = [
  rule("deletion", 1),
  rule("non_fast_forward", 1),
  rule("required_linear_history", 1),
  rule("pull_request", 1),
  ciRule(),
];

function ruleset(
  id: number,
  name: string,
  bypass: JsonValue[] = [ADMIN],
): JsonObject {
  return { id, name, bypass_actors: bypass };
}

function repoWorld(rules: JsonValue[], sets: JsonObject[] = []): FakeApi {
  const api = new FakeApi()
    .org([{ name: "mongodb" }])
    .route("/repos/AntelopeJS/mongodb/rules/branches/main", rules);
  for (const set of sets) {
    api.route(`/orgs/AntelopeJS/rulesets/${String(set.id)}`, set);
    api.route(`/repos/AntelopeJS/mongodb/rulesets/${String(set.id)}`, set);
  }
  return api;
}

const ORG_SETS = [
  ruleset(1, "Default branch protection"),
  ruleset(2, "Required CI"),
];

function subjects(result: CheckResult): string[] {
  assert.equal(result.kind, "findings");
  return result.kind === "findings"
    ? result.findings.map(({ subject, severity }) => `${subject}:${severity}`)
    : [];
}

test("a default branch under both organization rulesets raises nothing", async () => {
  const api = repoWorld(PROTECTED, ORG_SETS);
  assert.deepEqual(subjects(await branchGovernance.run(api.context())), []);
});

test("a repository with no rules on its default branch lacks the four rules urgently and the check normally", async () => {
  const api = repoWorld([]);
  assert.deepEqual(subjects(await branchGovernance.run(api.context())), [
    "main:rule:deletion:urgent",
    "main:rule:non_fast_forward:urgent",
    "main:rule:required_linear_history:urgent",
    "main:rule:pull_request:urgent",
    "main:checks:normal",
  ]);
});

test("a required check from another app does not count as GitHub Actions", async () => {
  const foreign = ciRule([{ context: "ci / checks", integration_id: 1 }]);
  const api = repoWorld([...PROTECTED.slice(0, 4), foreign], ORG_SETS);
  assert.deepEqual(subjects(await branchGovernance.run(api.context())), [
    "main:checks:normal",
  ]);
});

test("a Maintain role that bypasses always on a repository ruleset is urgent bypass drift naming the ruleset and the actor", async () => {
  const api = repoWorld(
    [...PROTECTED, rule("deletion", 3, "Repository")],
    [...ORG_SETS, ruleset(3, "Main", [ADMIN, MAINTAIN])],
  );
  const result = await branchGovernance.run(api.context());
  assert.deepEqual(subjects(result), ["main:bypass:urgent"]);
  assert.equal(result.kind, "findings");
  if (result.kind === "findings") {
    assert.match(result.findings[0].evidence, /Main \(repository ruleset 3\)/);
    assert.match(result.findings[0].evidence, /RepositoryRole 2 \(always\)/);
  }
});

test("an administrator bypass in any mode, and an organization administrator, raise nothing", async () => {
  const sets = [
    ruleset(1, "Default branch protection", [
      ADMIN,
      { ...ADMIN, bypass_mode: "pull_request" },
      { actor_type: "OrganizationAdmin", actor_id: 1, bypass_mode: "always" },
    ]),
    ruleset(2, "Required CI"),
  ];
  const api = repoWorld(PROTECTED, sets);
  assert.deepEqual(subjects(await branchGovernance.run(api.context())), []);
});

test("a ruleset read without its bypass list fails the repository instead of passing it", async () => {
  const api = repoWorld(PROTECTED, [
    { id: 1, name: "Default branch protection" },
    ruleset(2, "Required CI"),
  ]);
  await assert.rejects(
    branchGovernance.run(api.context()),
    /mongodb: Default branch protection \(organization ruleset 1\) returned no bypass list/,
  );
});

test("an organization ruleset is read once however many repositories it covers", async () => {
  const api = new FakeApi().org([{ name: "mongodb" }, { name: "redis" }]);
  for (const name of ["mongodb", "redis"])
    api.route(`/repos/AntelopeJS/${name}/rules/branches/main`, PROTECTED);
  for (const set of ORG_SETS)
    api.route(`/orgs/AntelopeJS/rulesets/${String(set.id)}`, set);
  await branchGovernance.run(api.context());
  assert.equal(
    api.requests.filter((path) => path === "/orgs/AntelopeJS/rulesets/1")
      .length,
    1,
  );
});

test("a repository outside the Required CI packs still needs the four rules, not the check", async () => {
  const api = new FakeApi()
    .org([{ name: "interfaces", pack: "none" }])
    .route("/repos/AntelopeJS/interfaces/rules/branches/main", []);
  assert.deepEqual(subjects(await branchGovernance.run(api.context())), [
    "main:rule:deletion:urgent",
    "main:rule:non_fast_forward:urgent",
    "main:rule:required_linear_history:urgent",
    "main:rule:pull_request:urgent",
  ]);
});

test("k8s-gitops-infra under its own ruleset needs every rule but linear history", async () => {
  const own = ["deletion", "non_fast_forward", "pull_request"].map((type) =>
    rule(type, 9, "Repository"),
  );
  const api = new FakeApi()
    .org([{ name: "k8s-gitops-infra", pack: "none" }])
    .route("/repos/AntelopeJS/k8s-gitops-infra/rules/branches/main", own)
    .route(
      "/repos/AntelopeJS/k8s-gitops-infra/rulesets/9",
      ruleset(9, "main-protection"),
    );
  assert.deepEqual(subjects(await branchGovernance.run(api.context())), []);
  api.route("/repos/AntelopeJS/k8s-gitops-infra/rules/branches/main", []);
  assert.deepEqual(subjects(await branchGovernance.run(api.context())), [
    "main:rule:deletion:urgent",
    "main:rule:non_fast_forward:urgent",
    "main:rule:pull_request:urgent",
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

function protection(overrides: JsonObject = {}): JsonObject {
  return {
    id: 12697152,
    name: "Default branch protection",
    target: "branch",
    enforcement: "active",
    conditions: {
      ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] },
      repository_name: { include: ["~ALL"], exclude: ["k8s-gitops-infra"] },
    },
    rules: [],
    ...overrides,
  };
}

function requiredCi(overrides: JsonObject = {}): JsonObject {
  return {
    id: 27029144,
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
    rules: [CI_RULE],
    ...overrides,
  };
}

function orgWorld(sets: JsonObject[]): FakeApi {
  const api = new FakeApi().route(
    "/orgs/AntelopeJS/rulesets",
    sets.map(({ id, name }) => ({ id, name })),
  );
  for (const set of sets)
    api.route(`/orgs/AntelopeJS/rulesets/${String(set.id)}`, set);
  return api;
}

test("the two organization rulesets as configured raise nothing", async () => {
  const api = orgWorld([protection(), requiredCi()]);
  assert.deepEqual(subjects(await orgChecksRuleset.run(api.context())), []);
});

test("a missing organization ruleset is urgent", async () => {
  const api = orgWorld([requiredCi()]);
  assert.deepEqual(subjects(await orgChecksRuleset.run(api.context())), [
    "ruleset:Default branch protection:urgent",
  ]);
});

test("an inactive organization ruleset is urgent", async () => {
  const api = orgWorld([protection({ enforcement: "evaluate" }), requiredCi()]);
  const result = await orgChecksRuleset.run(api.context());
  assert.deepEqual(subjects(result), [
    "ruleset:Default branch protection:urgent",
  ]);
  assert.equal(result.kind, "findings");
  if (result.kind === "findings")
    assert.match(result.findings[0].evidence, /enforcement active/);
});

test("Default branch protection that no longer covers every repository is urgent", async () => {
  const narrowed = protection({
    conditions: {
      ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] },
      repository_name: { include: ["mongodb"], exclude: [] },
    },
  });
  assert.deepEqual(
    subjects(
      await orgChecksRuleset.run(orgWorld([narrowed, requiredCi()]).context()),
    ),
    ["ruleset:Default branch protection:urgent"],
  );
});

test("Default branch protection that excludes another repository or a ref is urgent", async () => {
  for (const conditions of [
    {
      ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] },
      repository_name: {
        include: ["~ALL"],
        exclude: ["k8s-gitops-infra", "dms-api"],
      },
    },
    {
      ref_name: { include: ["~DEFAULT_BRANCH"], exclude: ["refs/heads/main"] },
      repository_name: { include: ["~ALL"], exclude: ["k8s-gitops-infra"] },
    },
  ])
    assert.deepEqual(
      subjects(
        await orgChecksRuleset.run(
          orgWorld([protection({ conditions }), requiredCi()]).context(),
        ),
      ),
      ["ruleset:Default branch protection:urgent"],
    );
});

test("a ruleset on every branch covers the default branch", async () => {
  const everyBranch = protection({
    conditions: {
      ref_name: { include: ["~ALL"], exclude: [] },
      repository_name: { include: ["~ALL"], exclude: ["k8s-gitops-infra"] },
    },
  });
  assert.deepEqual(
    subjects(
      await orgChecksRuleset.run(
        orgWorld([everyBranch, requiredCi()]).context(),
      ),
    ),
    [],
  );
});

test("two organization rulesets with the same name are urgent", async () => {
  const api = orgWorld([protection(), protection({ id: 1 }), requiredCi()]);
  assert.deepEqual(subjects(await orgChecksRuleset.run(api.context())), [
    "ruleset:Default branch protection:urgent",
  ]);
});

test("Required CI that lost its ci / checks requirement is urgent", async () => {
  const api = orgWorld([protection(), requiredCi({ rules: [] })]);
  const result = await orgChecksRuleset.run(api.context());
  assert.deepEqual(subjects(result), ["ruleset:Required CI:urgent"]);
  assert.equal(result.kind, "findings");
  if (result.kind === "findings")
    assert.match(result.findings[0].evidence, /ci \/ checks/);
});

test("Required CI that no longer targets the template pack is urgent", async () => {
  const fullOnly = requiredCi({
    conditions: {
      ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] },
      repository_property: {
        include: [
          { name: "pack", source: "custom", property_values: ["full"] },
        ],
        exclude: [],
      },
    },
  });
  assert.deepEqual(
    subjects(
      await orgChecksRuleset.run(orgWorld([protection(), fullOnly]).context()),
    ),
    ["ruleset:Required CI:urgent"],
  );
});
