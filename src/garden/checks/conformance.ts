import {
  CI_CONTEXT,
  CI_JOB_ID,
  CI_NODE_REF,
  CI_PATH,
} from "../../guardrails/ci-workflow.ts";
import { ciNodeCallers } from "../../guardrails/workflow.ts";
import { perRepo, type Check } from "../check.ts";
import { GardenContext, type GardenRepo } from "../context.ts";
import { tooling } from "../npm.ts";
import { finding, found, type CheckResult, type Finding } from "../types.ts";

const CHECK = "conformance";
const DAY = 24 * 60 * 60 * 1000;
const RENOVATE_CONFIGS = [
  "renovate.json",
  "renovate.json5",
  ".github/renovate.json",
  ".github/renovate.json5",
  ".renovaterc",
  ".renovaterc.json",
];
const RENOVATE_PRESET = /github>AntelopeJS\/\.github(?::|\/)/;
const MEND_EXEMPT = new Set(["k8s-gitops-infra"]);

function problem(
  repo: GardenRepo,
  subject: string,
  evidence: string,
  doneMeans: string,
): Finding {
  return finding(
    { repo: repo.name, check: CHECK, subject },
    evidence,
    doneMeans,
  );
}

async function ciCaller(
  context: GardenContext,
  repo: GardenRepo,
): Promise<Finding[]> {
  const text = await context.file(repo, CI_PATH);
  if (text === undefined)
    return [
      problem(
        repo,
        "ci-caller",
        `${CI_PATH} does not exist.`,
        `${CI_PATH} has a job calling ${CI_NODE_REF}.`,
      ),
    ];
  const callers = ciNodeCallers(text);
  if (!callers.length)
    return [
      problem(
        repo,
        "ci-caller",
        `${CI_PATH} has no job calling ci-node.yml.`,
        `${CI_PATH} has a job calling ${CI_NODE_REF}.`,
      ),
    ];
  const findings: Finding[] = [];
  const unpinned = callers.filter(({ uses }) => uses !== CI_NODE_REF);
  if (unpinned.length === callers.length)
    findings.push(
      problem(
        repo,
        "ci-caller",
        `${CI_PATH} calls ${unpinned[0].uses}.`,
        `The caller uses ${CI_NODE_REF}.`,
      ),
    );
  if (!callers.some(({ id, named }) => id === CI_JOB_ID && !named))
    findings.push(
      problem(
        repo,
        "ci-job-id",
        `The caller job is ${callers[0].id}${callers[0].named ? " with a name" : ""}, so the check is not reported as ${CI_CONTEXT}.`,
        `antelopejs-sync has renamed the caller job to ${CI_JOB_ID} and removed its name.`,
      ),
    );
  return findings;
}

async function renovateConfig(
  context: GardenContext,
  repo: GardenRepo,
): Promise<Finding[]> {
  const tree = await context.tree(repo);
  const path = RENOVATE_CONFIGS.find((candidate) => tree.includes(candidate));
  const text = path === undefined ? undefined : await context.file(repo, path);
  if (text !== undefined && RENOVATE_PRESET.test(text)) return [];
  return [
    problem(
      repo,
      "renovate-config",
      path === undefined
        ? "No Renovate configuration file."
        : `${path} does not extend the AntelopeJS preset.`,
      "renovate.json extends github>AntelopeJS/.github:renovate.json5.",
    ),
  ];
}

const LOCK_ENTRY =
  /'?@antelopejs\/tooling-configs'?:\s*\n\s+specifier:[^\n]*\n\s+version:\s*'?(\d[^\s'(]*)/;

/** The version the lockfile resolves, or the declared version when there is no pnpm lockfile. */
async function installed(
  context: GardenContext,
  repo: GardenRepo,
  range: string,
): Promise<string> {
  const lock = await context.file(repo, "pnpm-lock.yaml");
  return lock?.match(LOCK_ENTRY)?.[1] ?? range.replace(/^[^\d]*/, "");
}

async function toolingVersion(
  context: GardenContext,
  repo: GardenRepo,
): Promise<Finding[]> {
  const manifests = await context.packages(repo);
  const range = manifests
    .map(({ tooling: declared }) => declared)
    .find((declared) => declared !== undefined);
  const latest = await tooling(context);
  const done = `@antelopejs/tooling-configs is ${latest} or a Renovate PR bumping it is under 7 days old.`;
  if (range === undefined)
    return [
      problem(
        repo,
        "tooling-configs",
        "@antelopejs/tooling-configs is not a dependency.",
        done,
      ),
    ];
  if ((await installed(context, repo, range)) === latest) return [];
  const now = context.api.now().getTime();
  const fresh = (await context.openPulls(repo)).some(
    (pull) =>
      pull.author === "renovate[bot]" &&
      /tooling-configs/.test(pull.title) &&
      now - pull.createdAt < 7 * DAY,
  );
  return fresh
    ? []
    : [
        problem(
          repo,
          "tooling-configs",
          `Declared ${range}, latest is ${latest}, and no Renovate PR under 7 days old bumps it.`,
          done,
        ),
      ];
}

async function checksStatus(
  context: GardenContext,
  repo: GardenRepo,
): Promise<Finding[]> {
  const branch = await context.targetBranch(repo);
  const [latest] = (await context.workflowRuns(repo, "ci.yml", branch)) ?? [];
  const runs = (
    await context.checkRuns(repo, latest?.headSha || branch)
  ).filter(({ name }) => name === CI_CONTEXT || name === "checks");
  const reported = runs.find(({ name }) => name === CI_CONTEXT);
  if (reported === undefined)
    return [
      problem(
        repo,
        "checks-context",
        `${branch} reports ${runs.length ? runs.map(({ name }) => name).join(", ") : "no checks"} instead of ${CI_CONTEXT}.`,
        `The latest run on ${branch} reports ${CI_CONTEXT}.`,
      ),
    ];
  return reported.conclusion === "success"
    ? []
    : [
        problem(
          repo,
          "checks-red",
          `${CI_CONTEXT} on ${branch} is ${reported.conclusion ?? "pending"}: ${reported.url}`,
          `${CI_CONTEXT} is green on ${branch}.`,
        ),
      ];
}

const GUARDRAILS_RATCHET = "guardrails.ratchet.json";

async function cleanRatchet(
  context: GardenContext,
  repo: GardenRepo,
): Promise<Finding[]> {
  const tree = await context.tree(repo);
  if (
    !tree.includes(GUARDRAILS_RATCHET) ||
    !(await context.removedInHistory(repo, GUARDRAILS_RATCHET))
  )
    return [];
  return [
    problem(
      repo,
      "ratchet",
      `${GUARDRAILS_RATCHET} is back after the history deleted it.`,
      `${GUARDRAILS_RATCHET} is deleted again.`,
    ),
  ];
}

async function scan(
  context: GardenContext,
  repo: GardenRepo,
): Promise<Finding[]> {
  return [
    ...(await ciCaller(context, repo)),
    ...(await renovateConfig(context, repo)),
    ...(await toolingVersion(context, repo)),
    ...(await checksStatus(context, repo)),
    ...(await cleanRatchet(context, repo)),
  ];
}

async function newRepos(context: GardenContext): Promise<Finding[]> {
  return (await context.repos())
    .filter(
      (repo) =>
        repo.pack === "none" &&
        repo.language === "TypeScript" &&
        (repo.tier === "N1" || repo.tier === "N2" || repo.tier === "N3"),
    )
    .map((repo) =>
      problem(
        repo,
        "new",
        "A TypeScript repository in N1-N3 without the guardrail pack.",
        "The repository runs antelopejs-sync and its pack property is full or template.",
      ),
    );
}

async function mendSelection(context: GardenContext): Promise<Finding[]> {
  const active = await context.renovateRepos();
  return (await context.repos())
    .filter(
      (repo) =>
        repo.tier !== "N4" &&
        !MEND_EXEMPT.has(repo.name) &&
        !active.has(repo.name),
    )
    .map((repo) =>
      problem(
        repo,
        "renovate-app",
        "No issue or pull request from the Renovate app: the repository is not in the app's selection.",
        "Antony adds the repository to the Mend Renovate app's selected repositories.",
      ),
    );
}

export const conformance: Check = {
  id: CHECK,
  async run(context): Promise<CheckResult> {
    const scanned = await perRepo(await context.scope(), (repo) =>
      scan(context, repo),
    );
    const extra = [
      ...(await newRepos(context)),
      ...(await mendSelection(context)),
    ];
    return scanned.kind === "findings"
      ? found([...scanned.findings, ...extra])
      : scanned;
  },
};
