import { CI_CONTEXT } from "../../guardrails/ci-workflow.ts";
import { perRepo, type Check } from "../check.ts";
import { GardenContext, ORG, type GardenRepo } from "../context.ts";
import {
  child,
  children,
  num,
  object,
  optNum,
  optStr,
  str,
  strings,
  flag,
  type JsonObject,
} from "../json.ts";
import { finding, found, skip, type Finding } from "../types.ts";

const ALLOWED_ADMINS = ["Upd4ting", "mwesto", "dada-sudo"];
export const AUTOMERGE = "NEXT_AUTOMERGE";
const CHECK = "next-governance";
const ACTIONS_APP = 15368;
const ADMIN_ROLE = 5;
const MAINTAIN_BLOCKED = "altabmachine";
const REQUIRED_CONTEXTS = [[CI_CONTEXT, "checks"], ["verify-gate"]];
const VERIFICATION_SKILL =
  /(?:^|\/)(?:\.agents\/skills|\.claude\/skills|skills)\/[^/]*verif[^/]*\/SKILL\.md$/i;

interface Ruleset {
  name: string;
  includes: string[];
  rules: JsonObject[];
  bypass: JsonObject[];
}

function branchTargets(ruleset: Ruleset, branch: string): boolean {
  return ruleset.includes.some(
    (ref) =>
      ref === `refs/heads/${branch}` ||
      (ref === "~DEFAULT_BRANCH" && branch !== "next"),
  );
}

async function rulesets(
  context: GardenContext,
  repo: GardenRepo,
): Promise<Ruleset[]> {
  const summaries = await context.api.pages(
    `/repos/${ORG}/${repo.name}/rulesets?includes_parents=true`,
  );
  const result: Ruleset[] = [];
  for (const summary of summaries) {
    const source = object(summary, "ruleset");
    if (
      optStr(source, "enforcement") !== "active" ||
      optStr(source, "target") !== "branch"
    )
      continue;
    const path =
      optStr(source, "source_type") === "Organization"
        ? `/orgs/${ORG}/rulesets/${num(source, "id")}`
        : `/repos/${ORG}/${repo.name}/rulesets/${num(source, "id")}`;
    const detail = object(await context.api.json(path), "ruleset");
    result.push({
      name: str(detail, "name"),
      includes: strings(
        child(child(detail, "conditions"), "ref_name"),
        "include",
      ),
      rules: children(detail, "rules"),
      bypass: children(detail, "bypass_actors"),
    });
  }
  return result;
}

function bypassWidened(set: Ruleset): boolean {
  return set.bypass.some((actor) => {
    const kind = optStr(actor, "actor_type");
    const admin =
      kind === "OrganizationAdmin" ||
      (kind === "RepositoryRole" && optNum(actor, "actor_id") === ADMIN_ROLE);
    return !admin || optStr(actor, "bypass_mode") !== "pull_request";
  });
}

function requiredContexts(sets: Ruleset[]): string[] {
  return sets.flatMap((set) =>
    set.rules
      .filter((rule) => optStr(rule, "type") === "required_status_checks")
      .flatMap((rule) =>
        children(child(rule, "parameters"), "required_status_checks")
          .filter((entry) => optNum(entry, "integration_id") === ACTIONS_APP)
          .map((entry) => str(entry, "context")),
      ),
  );
}

function pullRules(sets: Ruleset[]): JsonObject[] {
  return sets.flatMap((set) =>
    set.rules
      .filter((rule) => optStr(rule, "type") === "pull_request")
      .map((rule) => child(rule, "parameters")),
  );
}

function branchFindings(
  repo: GardenRepo,
  branch: string,
  sets: Ruleset[],
): Finding[] {
  const hit = sets.filter((set) => branchTargets(set, branch));
  const findings: Finding[] = [];
  const report = (subject: string, evidence: string, urgent: boolean) =>
    findings.push(
      finding(
        { repo: repo.name, check: CHECK, subject: `${branch}:${subject}` },
        evidence,
        `The ${branch} rulesets match the Next channel merge policy.`,
        urgent ? "urgent" : "normal",
      ),
    );
  const contexts = requiredContexts(hit);
  if (!contexts.includes("verify-gate"))
    report(
      "verify-gate",
      `No ruleset on ${branch} requires verify-gate from GitHub Actions.`,
      true,
    );
  if (!REQUIRED_CONTEXTS[0].some((name) => contexts.includes(name)))
    report(
      "checks",
      `No ruleset on ${branch} requires ${CI_CONTEXT} from GitHub Actions.`,
      false,
    );
  const reviews = pullRules(hit);
  if (
    reviews.some(
      (rule) =>
        (optNum(rule, "required_approving_review_count") ?? 0) > 0 ||
        flag(rule, "require_code_owner_review") ||
        flag(rule, "require_last_push_approval"),
    )
  )
    report("review-rule", `A ruleset on ${branch} requires a review.`, true);
  if (
    !reviews.length ||
    !reviews.every(
      (rule) => strings(rule, "allowed_merge_methods").join() === "squash",
    )
  )
    report(
      "squash-only",
      `${branch} does not allow squash merges only.`,
      false,
    );
  if (hit.some(bypassWidened))
    report(
      "bypass",
      `The bypass list of ${hit
        .filter(bypassWidened)
        .map((set) => set.name)
        .join(", ")} holds more than the pull-request-only administrators.`,
      true,
    );
  return findings;
}

async function people(
  context: GardenContext,
  repo: GardenRepo,
): Promise<Finding[]> {
  const members = await context.api.pages(
    `/repos/${ORG}/${repo.name}/collaborators?affiliation=all`,
  );
  const findings: Finding[] = [];
  for (const member of members.map((entry) => object(entry, "collaborator"))) {
    const login = str(member, "login");
    const role = optStr(member, "role_name");
    if (role === "admin" && !ALLOWED_ADMINS.includes(login))
      findings.push(
        finding(
          { repo: repo.name, check: CHECK, subject: `admin:${login}` },
          `${login} holds admin.`,
          `${login} holds write or lower.`,
        ),
      );
    if (login === MAINTAIN_BLOCKED && (role === "maintain" || role === "admin"))
      findings.push(
        finding(
          { repo: repo.name, check: CHECK, subject: `maintain:${login}` },
          `${login} holds ${role}.`,
          `${login} holds no maintain.`,
        ),
      );
  }
  return findings;
}

async function scope(
  context: GardenContext,
  repo: GardenRepo,
  value: string,
): Promise<Finding[]> {
  if (value !== "on") return [];
  const skill = (await context.tree(repo)).some((path) =>
    VERIFICATION_SKILL.test(path),
  );
  return repo.tier === "N1" || repo.tier === "N2"
    ? skill
      ? []
      : [
          finding(
            { repo: repo.name, check: CHECK, subject: "automerge-scope" },
            `${AUTOMERGE}=on without a Verification skill on ${repo.defaultBranch}.`,
            `${AUTOMERGE} is shadow or off, or the repository has a Verification skill.`,
          ),
        ]
    : [
        finding(
          { repo: repo.name, check: CHECK, subject: "automerge-scope" },
          `${AUTOMERGE}=on on a ${repo.tier ?? "untiered"} repository.`,
          `${AUTOMERGE} is on only in N1 and N2.`,
        ),
      ];
}

async function governed(
  context: GardenContext,
  repo: GardenRepo,
  value: string,
): Promise<Finding[]> {
  const sets = await rulesets(context, repo);
  const branches =
    (await context.targetBranch(repo)) === "next"
      ? ["next", repo.defaultBranch]
      : [repo.defaultBranch];
  return [
    ...branches.flatMap((branch) => branchFindings(repo, branch, sets)),
    ...(await people(context, repo)),
    ...(await scope(context, repo, value)),
  ];
}

export const nextGovernance: Check = {
  id: CHECK,
  async run(context) {
    const values = new Map<string, string>();
    const repos = await context.scope();
    await perRepo(repos, async (repo) => {
      const value = await context.variable(repo, AUTOMERGE);
      if (value !== undefined) values.set(repo.name, value);
      return [];
    });
    if (!values.size)
      return skip(
        `${AUTOMERGE} exists on no repository yet (the verify-gate task has not landed).`,
      );
    return perRepo(
      repos.filter((repo) => values.has(repo.name)),
      (repo) => governed(context, repo, values.get(repo.name) ?? ""),
    );
  },
};

export const governanceDrift: Check = {
  id: "governance-drift",
  async run(context) {
    const owners = await context.organizationOwners();
    return found(
      owners
        .filter((login) => !ALLOWED_ADMINS.includes(login))
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

export const orgChecksRuleset: Check = {
  id: "org-checks-ruleset",
  async run() {
    return skip("ruleset postponed until the sync fan-out");
  },
};
