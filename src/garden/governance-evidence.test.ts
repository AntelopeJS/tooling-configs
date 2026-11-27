import assert from "node:assert/strict";
import test from "node:test";

import { branchGovernance } from "./checks/governance.ts";
import { FakeApi } from "./helpers/fake-api.ts";
import type { JsonObject, JsonValue } from "./json.ts";
import type { CheckResult } from "./types.ts";

const UNMET = [
  [
    "rule:deletion",
    "The rules in force on main hold no deletion rule.",
    "The rules in force on main hold a deletion rule.",
  ],
  [
    "rule:non_fast_forward",
    "The rules in force on main hold no non_fast_forward rule.",
    "The rules in force on main hold a non_fast_forward rule.",
  ],
  [
    "rule:required_linear_history",
    "The rules in force on main hold no required_linear_history rule.",
    "The rules in force on main hold a required_linear_history rule.",
  ],
  [
    "rule:pull_request",
    "The rules in force on main hold no pull_request rule.",
    "The rules in force on main hold a pull_request rule.",
  ],
  [
    "checks",
    "The rules in force on main hold no verdict or ci / checks from GitHub Actions as a required status check.",
    "The rules in force on main hold verdict or ci / checks from GitHub Actions as a required status check.",
  ],
  [
    "rule:merge_queue",
    "The rules in force on main hold no merge_queue rule.",
    "The rules in force on main hold a merge_queue rule.",
  ],
];

test("an unmet rule reads 'hold no <rule>' with no doubled article, and its done means names it with one", async () => {
  const api = new FakeApi()
    .org([{ name: "mongodb" }])
    .route("/repos/AntelopeJS/mongodb/rules/branches/main", []);
  const result = await branchGovernance.run(api.context());
  assert.equal(result.kind, "findings");
  if (result.kind !== "findings") return;
  assert.deepEqual(
    result.findings.map(({ subject, evidence, doneMeans }) => [
      subject.replace("main:", ""),
      evidence,
      doneMeans,
    ]),
    UNMET,
  );
});

const ADMIN = {
  actor_type: "RepositoryRole",
  actor_id: 5,
  bypass_mode: "pull_request",
};
const ADMIN_ALWAYS = { ...ADMIN, bypass_mode: "always" };
const MAINTAIN_ALWAYS = {
  actor_type: "RepositoryRole",
  actor_id: 2,
  bypass_mode: "always",
};
const OTHER_APP = {
  actor_type: "Integration",
  actor_id: 7,
  bypass_mode: "pull_request",
};
const OWN_RULES = ["deletion", "non_fast_forward", "pull_request"];
const EVERY_RULE = [...OWN_RULES, "required_linear_history", "merge_queue"];

type Source = "Organization" | "Repository";

function rule(type: string, id: number, source: Source): JsonObject {
  return {
    type,
    parameters: {},
    ruleset_source_type: source,
    ruleset_source: "AntelopeJS",
    ruleset_id: id,
  };
}

function world(
  repo: string,
  types: readonly string[],
  source: Source,
  bypass: JsonValue[],
): FakeApi {
  return new FakeApi()
    .org([{ name: repo, pack: "none" }])
    .route(
      `/repos/AntelopeJS/${repo}/rules/branches/main`,
      types.map((type) => rule(type, 9, source)),
    )
    .route(`/repos/AntelopeJS/${repo}/rulesets/9`, {
      id: 9,
      name: "main-protection",
      bypass_actors: bypass,
    });
}

function gitops(bypass: JsonValue[], source: Source = "Repository"): FakeApi {
  return world("k8s-gitops-infra", OWN_RULES, source, bypass);
}

function subjects(result: CheckResult): string[] {
  assert.equal(result.kind, "findings");
  return result.kind === "findings"
    ? result.findings.map(({ subject, severity }) => `${subject}:${severity}`)
    : [];
}

test("the own ruleset of k8s-gitops-infra may let the admin role bypass always, where one allowlist for every repository reports the bypass argocd-image-updater pushes to main through", async () => {
  for (const bypass of [[ADMIN_ALWAYS], [ADMIN, ADMIN_ALWAYS]])
    assert.deepEqual(
      subjects(await branchGovernance.run(gitops(bypass).context())),
      [],
    );
});

test("another actor on the k8s-gitops-infra ruleset is still drift and the finding names that actor alone, where an exception for the whole repository lets every actor through", async () => {
  const result = await branchGovernance.run(
    gitops([ADMIN_ALWAYS, OTHER_APP]).context(),
  );
  assert.deepEqual(subjects(result), ["main:bypass:urgent"]);
  assert.equal(result.kind, "findings");
  if (result.kind === "findings") {
    const [{ evidence, doneMeans }] = result.findings;
    const who =
      "the admin repository role (pull_request mode) and the antelopejs-release GitHub App (always mode), and in the repository's own ruleset the admin repository role (always mode),";
    assert.equal(
      evidence,
      `Rulesets on main let actors bypass them that only ${who} may: main-protection (repository ruleset 9): Integration 7 (pull_request).`,
    );
    assert.equal(doneMeans, `Only ${who} can bypass the rulesets on main.`);
  }
  assert.deepEqual(
    subjects(await branchGovernance.run(gitops([MAINTAIN_ALWAYS]).context())),
    ["main:bypass:urgent"],
  );
});

test("an organization ruleset that lets the admin role bypass always is drift on k8s-gitops-infra too, where an exception keyed on the repository alone accepts it", async () => {
  assert.deepEqual(
    subjects(
      await branchGovernance.run(
        gitops([ADMIN_ALWAYS], "Organization").context(),
      ),
    ),
    ["main:bypass:urgent"],
  );
});

test("a repository ruleset that lets the admin role bypass always is drift on any other repository and its finding names no exception, where an exception keyed on the actor alone accepts it everywhere", async () => {
  const result = await branchGovernance.run(
    world("mongodb", EVERY_RULE, "Repository", [ADMIN_ALWAYS]).context(),
  );
  assert.deepEqual(subjects(result), ["main:bypass:urgent"]);
  assert.equal(result.kind, "findings");
  if (result.kind === "findings")
    assert.equal(
      result.findings[0].evidence,
      "Rulesets on main let actors bypass them that only the admin repository role (pull_request mode) and the antelopejs-release GitHub App (always mode) may: main-protection (repository ruleset 9): RepositoryRole 5 (always).",
    );
});
