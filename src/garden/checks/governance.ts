import { CI_CONTEXT } from "../../guardrails/ci-workflow.ts";
import { PartialFailure, perRepo, scanEach, type Check } from "../check.ts";
import { GardenContext, Memo, ORG, type GardenRepo } from "../context.ts";
import {
  child,
  children,
  list,
  num,
  object,
  optNum,
  optStr,
  str,
  strings,
  type JsonObject,
} from "../json.ts";
import { finding, found, type Finding, type Severity } from "../types.ts";

const ALLOWED_OWNERS = ["Upd4ting", "mwesto", "dada-sudo"];
const ALLOWED_REPO_ADMINS = [
  "Upd4ting",
  "mwesto",
  "dada-sudo",
  "Thomasims",
  "alessaloisio",
];
const ACTIONS_APP = 15368;
const ADMIN_ROLE = 5;
const DEFAULT_BRANCH_REF = "~DEFAULT_BRANCH";
const REQUIRED_RULES = [
  "deletion",
  "non_fast_forward",
  "required_linear_history",
  "pull_request",
] as const;

/** Repositories the organization ruleset excludes because their own ruleset governs them, with the required rules that ruleset does not hold. */
const OWN_POLICY: ReadonlyMap<
  string,
  readonly (typeof REQUIRED_RULES)[number][]
> = new Map([["k8s-gitops-infra", ["required_linear_history"]]]);

/** The packs that Required CI covers. */
const CI_PACKS = ["full", "template"] as const;

interface Requirement {
  subject: string;
  severity: Severity;
  need: string;
  applies(repo: GardenRepo): boolean;
  met(rules: readonly JsonObject[]): boolean;
}

function requiresCi(rules: readonly JsonObject[]): boolean {
  return rules.some(
    (rule) =>
      optStr(rule, "type") === "required_status_checks" &&
      children(child(rule, "parameters"), "required_status_checks").some(
        (entry) =>
          optStr(entry, "context") === CI_CONTEXT &&
          optNum(entry, "integration_id") === ACTIONS_APP,
      ),
  );
}

const REQUIREMENTS: readonly Requirement[] = [
  ...REQUIRED_RULES.map((type): Requirement => ({
    subject: `rule:${type}`,
    severity: "urgent",
    need: `a ${type} rule`,
    applies: (repo) => !OWN_POLICY.get(repo.name)?.includes(type),
    met: (rules) => rules.some((rule) => optStr(rule, "type") === type),
  })),
  {
    subject: "checks",
    severity: "normal",
    need: `${CI_CONTEXT} from GitHub Actions as a required status check`,
    applies: (repo) => CI_PACKS.some((pack) => pack === repo.pack),
    met: requiresCi,
  },
];

/** Actors that may bypass a default branch ruleset, in any bypass mode: the release workflow pushes with an administrator's token. */
const ALLOWED_BYPASS: readonly { type: string; id?: number }[] = [
  { type: "RepositoryRole", id: ADMIN_ROLE },
  { type: "OrganizationAdmin" },
];

function mayBypass(actor: JsonObject): boolean {
  const type = optStr(actor, "actor_type");
  const id = optNum(actor, "actor_id");
  return ALLOWED_BYPASS.some(
    (allowed) =>
      allowed.type === type && (allowed.id === undefined || allowed.id === id),
  );
}

function describeActor(actor: JsonObject): string {
  return `${optStr(actor, "actor_type") ?? "unknown"} ${optNum(actor, "actor_id") ?? "none"} (${optStr(actor, "bypass_mode") ?? "unknown"})`;
}

/** A ruleset that contributes a rule to a default branch, read through the repository endpoint, which serves organization rulesets without the `admin:org` scope. */
interface RulesetRef {
  readonly key: string;
  readonly path: string;
  readonly label: string;
}

function rulesetRef(repo: GardenRepo, rule: JsonObject): RulesetRef {
  const id = num(rule, "ruleset_id");
  const organization = optStr(rule, "ruleset_source_type") === "Organization";
  return {
    key: organization ? `${ORG}:${id}` : `${ORG}/${repo.name}:${id}`,
    path: `/repos/${ORG}/${repo.name}/rulesets/${id}`,
    label: `${organization ? "organization" : "repository"} ruleset ${id}`,
  };
}

type RulesetReader = (ref: RulesetRef) => Promise<JsonObject>;

function rulesetReader(context: GardenContext): RulesetReader {
  const cache = new Memo<JsonObject>();
  return (ref) =>
    cache.get(ref.key, async () =>
      object(await context.api.json(ref.path), "ruleset"),
    );
}

async function bypassOffenders(
  read: RulesetReader,
  refs: readonly RulesetRef[],
): Promise<string[]> {
  const offenders: string[] = [];
  for (const ref of refs) {
    const set = await read(ref);
    const name = `${str(set, "name")} (${ref.label})`;
    const listed = set["bypass_actors"];
    if (listed === undefined)
      throw new Error(
        `${name} returned no bypass list; the Gardener token must belong to an administrator.`,
      );
    const actors = list(listed, "bypass_actors")
      .map((actor) => object(actor, "bypass_actors"))
      .filter((actor) => !mayBypass(actor));
    if (actors.length)
      offenders.push(`${name}: ${actors.map(describeActor).join(", ")}`);
  }
  return offenders;
}

async function scanBranch(
  context: GardenContext,
  read: RulesetReader,
  repo: GardenRepo,
): Promise<Finding[]> {
  const branch = repo.defaultBranch;
  const rules = (
    await context.api.pages(
      `/repos/${ORG}/${repo.name}/rules/branches/${encodeURIComponent(branch)}`,
    )
  ).map((entry) => object(entry, "rule"));
  const report = (
    subject: string,
    evidence: string,
    doneMeans: string,
    severity: Severity,
  ) =>
    finding(
      {
        repo: repo.name,
        check: "branch-governance",
        subject: `${branch}:${subject}`,
      },
      evidence,
      doneMeans,
      severity,
    );
  const unmet = REQUIREMENTS.filter(
    (entry) => entry.applies(repo) && !entry.met(rules),
  ).map((entry) =>
    report(
      entry.subject,
      `The rules in force on ${branch} hold no ${entry.need}.`,
      `The rules in force on ${branch} hold ${entry.need}.`,
      entry.severity,
    ),
  );
  const offenders = await bypassOffenders(read, [
    ...new Map(
      rules.map((rule) => rulesetRef(repo, rule)).map((ref) => [ref.key, ref]),
    ).values(),
  ]);
  return offenders.length
    ? [
        ...unmet,
        report(
          "bypass",
          `Rulesets on ${branch} let actors other than administrators bypass them: ${offenders.join("; ")}.`,
          `Only the admin role and organization administrators can bypass the rulesets on ${branch}.`,
          "urgent",
        ),
      ]
    : unmet;
}

export const branchGovernance: Check = {
  id: "branch-governance",
  async run(context) {
    const read = rulesetReader(context);
    return perRepo(await context.repos(), (repo) =>
      scanBranch(context, read, repo),
    );
  },
};

export const governanceDrift: Check = {
  id: "governance-drift",
  async run(context) {
    const owners = await context.organizationOwners();
    return found(
      owners
        .filter((login) => !ALLOWED_OWNERS.includes(login))
        .map((login) =>
          finding(
            {
              repo: ORG,
              check: "governance-drift",
              subject: `org-admin:${login}`,
            },
            `${login} is an organization owner.`,
            `${login} is a member, or the allowed administrators change.`,
          ),
        ),
    );
  },
};

/** One finding per login that holds `admin` on a repository and is not an allowed repo administrator, listing the repositories; `maintain` has no bypass and is not read. */
export const repoAdmins: Check = {
  id: "repo-admins",
  async run(context) {
    const { results, failures } = await scanEach(
      await context.repos(),
      async (repo) =>
        (await context.repoAdmins(repo))
          .filter((login) => !ALLOWED_REPO_ADMINS.includes(login))
          .map((login) => ({ login, repo: repo.name })),
    );
    const held = new Map<string, string[]>();
    for (const { login, repo } of results)
      held.set(login, [...(held.get(login) ?? []), repo]);
    const findings = [...held].map(([login, repos]) =>
      finding(
        {
          repo: ORG,
          check: "repo-admins",
          subject: `repo-admin:${login}`,
        },
        `${login} holds admin on ${repos.length} ${repos.length === 1 ? "repository" : "repositories"}: ${repos.join(", ")}.`,
        `${login} holds no admin role on those repositories, or the allowed repository administrators change.`,
      ),
    );
    if (failures.length) throw new PartialFailure(findings, failures);
    return found(findings);
  },
};

interface Expectation {
  what: string;
  holds(ruleset: JsonObject): boolean;
}

const ACTIVE: Expectation = {
  what: "enforcement active",
  holds: (set) => optStr(set, "enforcement") === "active",
};

const ON_BRANCHES: Expectation = {
  what: "target branch",
  holds: (set) => optStr(set, "target") === "branch",
};

function condition(set: JsonObject, name: string, key: string): string[] {
  return strings(child(child(set, "conditions"), name), key);
}

function sameNames(actual: readonly string[], wanted: readonly string[]) {
  return [...actual].sort().join() === [...wanted].sort().join();
}

const ON_DEFAULT_BRANCH: Expectation = {
  what: `ref ${DEFAULT_BRANCH_REF} with no ref excluded`,
  holds: (set) =>
    condition(set, "ref_name", "include").some(
      (ref) => ref === DEFAULT_BRANCH_REF || ref === "~ALL",
    ) && !condition(set, "ref_name", "exclude").length,
};

const ORG_RULESETS: readonly {
  name: string;
  expects: readonly Expectation[];
}[] = [
  {
    name: "Default branch protection",
    expects: [
      ACTIVE,
      ON_BRANCHES,
      ON_DEFAULT_BRANCH,
      {
        what: `repository_name include ~ALL, exclude only ${[...OWN_POLICY.keys()].join(", ")}`,
        holds: (set) =>
          condition(set, "repository_name", "include").includes("~ALL") &&
          sameNames(condition(set, "repository_name", "exclude"), [
            ...OWN_POLICY.keys(),
          ]),
      },
    ],
  },
  {
    name: "Required CI",
    expects: [
      ACTIVE,
      ON_BRANCHES,
      ON_DEFAULT_BRANCH,
      {
        what: "repository property pack in full and template",
        holds: (set) =>
          children(
            child(child(set, "conditions"), "repository_property"),
            "include",
          ).some(
            (entry) =>
              optStr(entry, "name") === "pack" &&
              CI_PACKS.every((value) =>
                strings(entry, "property_values").includes(value),
              ),
          ),
      },
      {
        what: `required status check ${CI_CONTEXT} from integration ${ACTIONS_APP}`,
        holds: (set) => requiresCi(children(set, "rules")),
      },
    ],
  },
];

async function orgDrift(
  context: GardenContext,
  summaries: readonly JsonObject[],
  policy: (typeof ORG_RULESETS)[number],
): Promise<Finding[]> {
  const make = (evidence: string) =>
    finding(
      {
        repo: ORG,
        check: "org-checks-ruleset",
        subject: `ruleset:${policy.name}`,
      },
      evidence,
      `The organization ruleset "${policy.name}" is back to its policy.`,
      "urgent",
    );
  const named = summaries.filter(
    (entry) => optStr(entry, "name") === policy.name,
  );
  const [summary] = named;
  if (summary === undefined)
    return [make(`The organization has no ruleset named "${policy.name}".`)];
  if (named.length > 1)
    return [
      make(
        `${named.length} organization rulesets are named "${policy.name}": ${named.map((entry) => num(entry, "id")).join(", ")}.`,
      ),
    ];
  const detail = object(
    await context.api.json(`/orgs/${ORG}/rulesets/${num(summary, "id")}`),
    "ruleset",
  );
  const unmet = policy.expects.filter((entry) => !entry.holds(detail));
  return unmet.length
    ? [
        make(
          `"${policy.name}" lacks: ${unmet.map((entry) => entry.what).join(", ")}.`,
        ),
      ]
    : [];
}

export const orgChecksRuleset: Check = {
  id: "org-checks-ruleset",
  async run(context) {
    const summaries = (await context.api.pages(`/orgs/${ORG}/rulesets`)).map(
      (entry) => object(entry, "ruleset"),
    );
    const findings: Finding[] = [];
    for (const policy of ORG_RULESETS)
      findings.push(...(await orgDrift(context, summaries, policy)));
    return found(findings);
  },
};
