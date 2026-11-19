import { perRepo, type Check } from "../check.ts";
import { GardenContext, ORG, type GardenRepo } from "../context.ts";
import { finding, type Finding } from "../types.ts";

const DAY = 24 * 60 * 60 * 1000;
const WINDOW_DAYS = 14;
const WORKFLOW = "ci.yml";
const TITLE = "Flaky test";
const SUFFIX = " passed only on its merge-queue retry.";
const LISTED_RUNS = 10;

/** The test a flaky annotation names: its message without the `<owner>/<repo>: ` prefix and the retry suffix, or the whole message when it lacks either. */
function testOf(repo: GardenRepo, message: string): string {
  const prefix = `${ORG}/${repo.name}: `;
  const whole =
    message.startsWith(prefix) &&
    message.endsWith(SUFFIX) &&
    message.length > prefix.length + SUFFIX.length;
  return whole ? message.slice(prefix.length, -SUFFIX.length) : message;
}

async function flaky(
  context: GardenContext,
  repo: GardenRepo,
): Promise<Finding[]> {
  const since = context.api.now().getTime() - WINDOW_DAYS * DAY;
  const runs = await context.mergeQueueRuns(repo, WORKFLOW, since);
  if (runs === undefined) return [];
  const urls = new Map<string, Set<string>>();
  for (const run of runs) {
    if (run.checkSuiteId === undefined || run.createdAt < since) continue;
    for (const check of await context.suiteCheckRuns(repo, run.checkSuiteId)) {
      if (check.annotations === 0) continue;
      for (const note of await context.annotations(repo, check.id)) {
        if (note.level !== "warning" || note.title !== TITLE) continue;
        const name = testOf(repo, note.message);
        const seen = urls.get(name) ?? new Set<string>();
        seen.add(run.url);
        urls.set(name, seen);
      }
    }
  }
  return [...urls.keys()].sort().map((name) => {
    const seen = [...(urls.get(name) ?? [])];
    return finding(
      { repo: repo.name, check: "flaky-tests", subject: name },
      `${name} passed only on its merge-queue retry in ${seen.length} ${WORKFLOW} run(s) over the last ${WINDOW_DAYS} days, the newest: ${seen.slice(0, LISTED_RUNS).join(", ")}`,
      `The test passes without a retry in the merge queue for ${WINDOW_DAYS} days.`,
    );
  });
}

/**
 * Flags each test that passed only on its merge-queue retry in a `ci.yml` run of the last 14 days. ci-node.yml writes
 * one warning annotation titled `Flaky test` per such test on a check run of the run's check suite; the check lists the
 * merge-queue runs once, reads annotations only of check runs that carry some, and groups them by test, one finding per
 * repository and test however many runs or check runs name it, its evidence listing the 10 newest runs.
 */
export const flakyTests: Check = {
  id: "flaky-tests",
  async run(context) {
    return perRepo(await context.scope(), (repo) => flaky(context, repo));
  },
};
