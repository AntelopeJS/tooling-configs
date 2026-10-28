import { GardenContext, mapLimit, type GardenRepo } from "./context.ts";
import type { CheckResult, Finding } from "./types.ts";
import { found } from "./types.ts";

export interface Check {
  id: string;
  run(context: GardenContext): Promise<CheckResult>;
}

/** A check that read some repositories and failed on others keeps what it found. */
export class PartialFailure extends Error {
  readonly findings: Finding[];

  constructor(findings: Finding[], failures: string[]) {
    super(failures.join("; "));
    this.findings = findings;
  }
}

const CONCURRENCY = 6;

/** Runs a scan on each repository; a failing repository is reported once, not allowed to hide the rest. */
export async function perRepo(
  repos: readonly GardenRepo[],
  scan: (repo: GardenRepo) => Promise<Finding[]>,
): Promise<CheckResult> {
  const failures: string[] = [];
  const results = await mapLimit(repos, CONCURRENCY, async (repo) => {
    try {
      return await scan(repo);
    } catch (error) {
      failures.push(
        `${repo.name}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return [];
    }
  });
  const findings = results.flat();
  if (failures.length) throw new PartialFailure(findings, failures.sort());
  return found(findings);
}
