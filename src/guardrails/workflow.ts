import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { isMap, isScalar, isSeq, parseDocument } from "yaml";

const CI_NODE_PATTERN =
  /^AntelopeJS\/\.github\/\.github\/workflows\/ci-node\.yml@\S+$/;

export const MISSING_CHECKS_WORKFLOW =
  "No workflow in .github/workflows runs pnpm run checks. Add a step running `pnpm run checks` (or `pnpm checks`), or a job using AntelopeJS/.github/.github/workflows/ci-node.yml@<ref>.";

export function hasChecksWorkflow(root: string): boolean {
  const directory = join(root, ".github/workflows");
  if (!existsSync(directory)) return false;
  for (const file of readdirSync(directory).filter((name) =>
    /\.ya?ml$/.test(name),
  )) {
    const document = parseDocument(readFileSync(join(directory, file), "utf8"));
    if (document.errors.length) continue;
    const jobs = document.get("jobs", true);
    if (!isMap(jobs)) continue;
    for (const { value: job } of jobs.items) {
      if (!isMap(job)) continue;
      const uses = job.get("uses", true);
      if (isScalar(uses) && CI_NODE_PATTERN.test(String(uses.value)))
        return true;
      const steps = job.get("steps", true);
      if (!isSeq(steps)) continue;
      for (const step of steps.items) {
        if (!isMap(step)) continue;
        const run = step.get("run", true);
        if (
          isScalar(run) &&
          /(?:^|\n|&&|;)\s*pnpm\s+(?:run\s+)?checks(?=\s*(?:$|\n|&&|;|#))/.test(
            String(run.value),
          )
        )
          return true;
      }
    }
  }
  return false;
}

export interface CiCaller {
  id: string;
  uses: string;
  named: boolean;
}

/** Jobs of a workflow file that call the shared Node CI; empty when the YAML does not parse. */
export function ciNodeCallers(text: string): CiCaller[] {
  const document = parseDocument(text);
  const jobs = document.errors.length ? undefined : document.get("jobs", true);
  if (!isMap(jobs)) return [];
  const callers: CiCaller[] = [];
  for (const { key, value: job } of jobs.items) {
    if (!isMap(job)) continue;
    const uses = job.get("uses", true);
    if (isScalar(uses) && CI_NODE_PATTERN.test(String(uses.value)))
      callers.push({
        id: String(isScalar(key) ? key.value : key),
        uses: String(uses.value),
        named: job.has("name"),
      });
  }
  return callers;
}
