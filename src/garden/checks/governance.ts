import {
  REQUIRED_CONTEXTS,
  REQUIRED_CONTEXTS_TEXT,
} from "../../guardrails/ci-workflow.ts";
import { ApiError } from "../api.ts";
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
import { finding, found, skip, type Finding, type Severity } from "../types.ts";

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

/** Repositories whose default branch has no merge queue, each with the reason. */
const WITHOUT_MERGE_QUEUE: ReadonlyMap<string, string> = new Map([
  ["cloud", "it collects changes on develop"],
  ["k8s-gitops-infra", "only a person merges there"],
  ["antelope-compliance", "an infra repository where only a person merges"],
  ["antelope-hardening", "an infra repository where only a person merges"],
  [
    "antelope-web",
    "argocd-image-updater pushes image-bump commits straight to main, which a merge queue would block",
  ],
]);

/** The packs that Required CI covers. */
const CI_PACKS = ["full", "template"] as const;

interface Requirement {
  subject: string;
  severity: Severity;
  need: string;
  article?: string;
  applies(repo: GardenRepo): boolean;
  met(rules: readonly JsonObject[]): boolean;
}

function requiresCi(rules: readonly JsonObject[]): boolean {
  return rules.some(
    (rule) =>
      optStr(rule, "type") === "required_status_checks" &&
      children(child(rule, "parameters"), "required_status_checks").some(
        (entry) =>
          REQUIRED_CONTEXTS.some(
            (context) => context === optStr(entry, "context"),
          ) && optNum(entry, "integration_id") === ACTIONS_APP,
      ),
  );
}

const REQUIREMENTS: readonly Requirement[] = [
  ...REQUIRED_RULES.map((type): Requirement => ({
    subject: `rule:${type}`,
    severity: "urgent",
    need: `${type} rule`,
    applies: (repo) => !OWN_POLICY.get(repo.name)?.includes(type),
    met: (rules) => rules.some((rule) => optStr(rule, "type") === type),
  })),
  {
    subject: "checks",
    severity: "normal",
    need: `${REQUIRED_CONTEXTS_TEXT} from GitHub Actions as a required status check`,
    article: "",
    applies: (repo) => CI_PACKS.some((pack) => pack === repo.pack),
    met: requiresCi,
  },
  {
    subject: "rule:merge_queue",
    severity: "normal",
    need: "merge_queue rule",
    applies: (repo) => !WITHOUT_MERGE_QUEUE.has(repo.name),
    met: (rules) =>
      rules.some((rule) => optStr(rule, "type") === "merge_queue"),
  },
];

interface BypassActor {
  readonly type: string;
  readonly id: number;
  readonly mode: string;
}

/** Actors that may bypass a default branch ruleset, as the organization rulesets set them: the admin repository role through a pull request only, and the `antelopejs-release` GitHub App always, which pushes release commits and tags to `main` and runs next-sync and the module-locks refresh. */
const ALLOWED_BYPASS: readonly BypassActor[] = [
  { type: "RepositoryRole", id: ADMIN_ROLE, mode: "pull_request" },
  { type: "Integration", id: 5854792, mode: "always" },
];

const ALLOWED_BYPASS_TEXT =
  "the admin repository role (pull_request mode) and the antelopejs-release GitHub App (always mode)";

/** Actors a repository's own ruleset may let bypass besides {@link ALLOWED_BYPASS}, each with the words that name it in a finding and the reason it is accepted. An organization ruleset gets no exception. */
const OWN_RULESET_BYPASS: ReadonlyMap<
  string,
  readonly (BypassActor & { readonly who: string; readonly reason: string })[]
> = new Map([
  [
    "k8s-gitops-infra",
    [
      {
        type: "RepositoryRole",
        id: ADMIN_ROLE,
        mode: "always",
        who: "the admin repository role (always mode)",
        reason:
          "argocd-image-updater and the platform automation push straight to main through it, which the pull_request mode would refuse",
      },
    ],
  ],
]);

function mayBypass(
  actor: JsonObject,
  allowed: readonly BypassActor[],
): boolean {
  const type = optStr(actor, "actor_type");
  const id = optNum(actor, "actor_id");
  const mode = optStr(actor, "bypass_mode");
  return allowed.some(
    (entry) => entry.type === type && entry.id === id && entry.mode === mode,
  );
}

function allowedBypassText(repo: GardenRepo): string {
  const own = OWN_RULESET_BYPASS.get(repo.name);
  return own
    ? `${ALLOWED_BYPASS_TEXT}, and in the repository's own ruleset ${own.map(({ who }) => who).join(" and ")},`
    : ALLOWED_BYPASS_TEXT;
}

function describeActor(actor: JsonObject): string {
  return `${optStr(actor, "actor_type") ?? "unknown"} ${optNum(actor, "actor_id") ?? "none"} (${optStr(actor, "bypass_mode") ?? "unknown"})`;
}

/** A ruleset that contributes a rule to a default branch, read through the repository endpoint, which serves organization rulesets without the `admin:org` scope. */
interface RulesetRef {
  readonly key: string;
  readonly path: string;
  readonly label: string;
  readonly organization: boolean;
}

function rulesetRef(repo: GardenRepo, rule: JsonObject): RulesetRef {
  const id = num(rule, "ruleset_id");
  const organization = optStr(rule, "ruleset_source_type") === "Organization";
  return {
    key: organization ? `${ORG}:${id}` : `${ORG}/${repo.name}:${id}`,
    path: `/repos/${ORG}/${repo.name}/rulesets/${id}`,
    label: `${organization ? "organization" : "repository"} ruleset ${id}`,
    organization,
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
  repo: GardenRepo,
  refs: readonly RulesetRef[],
): Promise<string[]> {
  const inOwnRuleset = [
    ...ALLOWED_BYPASS,
    ...(OWN_RULESET_BYPASS.get(repo.name) ?? []),
  ];
  const offenders: string[] = [];
  for (const ref of refs) {
    const set = await read(ref);
    const name = `${str(set, "name")} (${ref.label})`;
    const listed = set["bypass_actors"];
    if (listed === undefined)
      throw new Error(
        `${name} returned no bypass list; the Gardener token must belong to an administrator.`,
      );
    const allowed = ref.organization ? ALLOWED_BYPASS : inOwnRuleset;
    const actors = list(listed, "bypass_actors")
      .map((actor) => object(actor, "bypass_actors"))
      .filter((actor) => !mayBypass(actor, allowed));
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
      `The rules in force on ${branch} hold ${entry.article ?? "a "}${entry.need}.`,
      entry.severity,
    ),
  );
  const offenders = await bypassOffenders(read, repo, [
    ...new Map(
      rules.map((rule) => rulesetRef(repo, rule)).map((ref) => [ref.key, ref]),
    ).values(),
  ]);
  const who = allowedBypassText(repo);
  return offenders.length
    ? [
        ...unmet,
        report(
          "bypass",
          `Rulesets on ${branch} let actors bypass them that only ${who} may: ${offenders.join("; ")}.`,
          `Only ${who} can bypass the rulesets on ${branch}.`,
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
        what: `required status check ${REQUIRED_CONTEXTS_TEXT} from integration ${ACTIONS_APP}`,
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
    let listed;
    try {
      listed = await context.api.pages(`/orgs/${ORG}/rulesets`);
    } catch (error) {
      if (error instanceof ApiError && error.missingScopes.length)
        return skip(
          `listing organization rulesets needs the ${error.missingScopes.join(" or ")} scope, which the token lacks`,
        );
      throw error;
    }
    const summaries = listed.map((entry) => object(entry, "ruleset"));
    const findings: Finding[] = [];
    for (const policy of ORG_RULESETS)
      findings.push(...(await orgDrift(context, summaries, policy)));
    return found(findings);
  },
};
