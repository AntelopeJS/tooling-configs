import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { isMap, isScalar, isSeq, parseDocument } from "yaml";

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
      if (
        isScalar(uses) &&
        /^AntelopeJS\/\.github\/\.github\/workflows\/ci-node\.yml@\S+$/.test(
          String(uses.value),
        )
      )
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
