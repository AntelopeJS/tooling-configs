import type { GardenApi } from "../api.ts";
import { perRepo, type Check } from "../check.ts";
import { GardenContext, ORG, type GardenRepo } from "../context.ts";
import type { Branch, PullRequest } from "../decode.ts";
import { finding, type Finding, type Prune } from "../types.ts";

const CHECK = "stale-branches";
const SUBJECT = "branches";
const DAY = 24 * 60 * 60 * 1000;
const INACTIVE_DAYS = 30;

/** Why a branch stays or goes; only `prune` verdicts are ever deleted. */
type Verdict = { kind: "keep" } | { kind: "prune"; reason: string };

/** What the classifier needs to know about one branch, read once per branch. */
interface BranchFacts {
  branch: Branch;
  defaultBranch: string;
  /** Open pull requests of the repository, from any head. */
  open: readonly PullRequest[];
  /** Closed and merged pull requests whose head is this branch of this repository, read only past the keep rules. */
  closed: () => Promise<readonly PullRequest[]>;
  /** Tip commit time, read only when the earlier rules did not decide. */
  tipTime: () => Promise<number>;
  now: number;
  repo: string;
}

function day(time: number): string {
  return new Date(time).toISOString().slice(0, 10);
}

function hasOpenPull(facts: BranchFacts): boolean {
  const { branch, open, repo } = facts;
  return open.some(
    (pull) =>
      pull.base === branch.name ||
      (pull.head === branch.name && pull.headRepo === `${ORG}/${repo}`),
  );
}

/** Decides one branch: the default, `next`, protected and open-PR branches always stay. */
async function classify(facts: BranchFacts): Promise<Verdict> {
  const { branch, defaultBranch, closed, now } = facts;
  if (branch.name === defaultBranch || branch.name === "next")
    return { kind: "keep" };
  if (branch.protected || hasOpenPull(facts)) return { kind: "keep" };
  const done = (await closed()).find((pull) => pull.headSha === branch.sha);
  if (done !== undefined)
    return {
      kind: "prune",
      reason: `${done.merged ? "merged" : "closed"} PR #${done.number}`,
    };
  const tip = await facts.tipTime();
  return now - tip >= INACTIVE_DAYS * DAY
    ? { kind: "prune", reason: `no commit since ${day(tip)}` }
    : { kind: "keep" };
}

async function prunable(
  context: GardenContext,
  repo: GardenRepo,
): Promise<Prune[]> {
  const [branches, open] = await Promise.all([
    context.branchList(repo),
    context.openPulls(repo),
  ]);
  const now = context.api.now().getTime();
  const prunes: Prune[] = [];
  for (const branch of branches) {
    const verdict = await classify({
      branch,
      defaultBranch: repo.defaultBranch,
      open,
      closed: () => context.closedPulls(repo, branch.name),
      tipTime: () => context.commitTime(repo, branch.sha),
      now,
      repo: repo.name,
    });
    if (verdict.kind === "prune")
      prunes.push({
        repo: repo.name,
        branch: branch.name,
        reason: verdict.reason,
      });
  }
  return prunes;
}

function report(repo: GardenRepo, prunes: readonly Prune[]): Finding[] {
  if (!prunes.length) return [];
  return [
    finding(
      { repo: repo.name, check: CHECK, subject: SUBJECT },
      prunes.map(({ branch, reason }) => `${branch} (${reason})`).join(", "),
      `No branch other than the default, next and protected ones is the head of a merged or closed PR, or has no open PR and no commit for ${INACTIVE_DAYS} days.`,
    ),
  ];
}

/** Lists, per repository, the branches `--apply-prunes` would delete. */
export const staleBranches: Check = {
  id: CHECK,
  async run(context) {
    return perRepo(await context.scope(), async (repo) =>
      report(repo, await prunable(context, repo)),
    );
  },
};

/** The deletions behind each stale-branches finding, re-read from the API given so a branch that gained an open PR or a commit since the scan is kept; a repository whose read failed is never pruned. */
export async function plannedPrunes(
  api: GardenApi,
  findings: readonly Finding[],
): Promise<{ prunes: Prune[]; failed: string[] }> {
  const fresh = new GardenContext(api);
  const flagged = new Set(
    findings
      .filter((entry) => entry.check === CHECK)
      .map((entry) => entry.repo),
  );
  const prunes: Prune[] = [];
  const failed: string[] = [];
  const scope = await fresh.scope().catch((error: unknown) => {
    failed.push(
      `organization listing: ${error instanceof Error ? error.message : String(error)}`,
    );
    return [];
  });
  for (const repo of scope)
    if (flagged.has(repo.name))
      await prunable(fresh, repo).then(
        (found) => prunes.push(...found),
        (error: unknown) =>
          failed.push(
            `${repo.name}: ${error instanceof Error ? error.message : String(error)}`,
          ),
      );
  return { prunes, failed };
}

function refPath(name: string): string {
  return name.split("/").map(encodeURIComponent).join("/");
}

/** Deletes each planned branch ref and nothing else; a failed deletion does not stop the rest and is returned. */
export async function applyPrunes(
  api: GardenApi,
  prunes: readonly Prune[],
): Promise<string[]> {
  const failed: string[] = [];
  for (const prune of prunes)
    await api
      .send(
        "DELETE",
        `/repos/${ORG}/${prune.repo}/git/refs/heads/${refPath(prune.branch)}`,
      )
      .catch((error: unknown) => {
        failed.push(
          `${prune.repo} ${prune.branch}: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
  return failed;
}
