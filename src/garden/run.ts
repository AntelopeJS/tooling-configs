import type { GardenApi } from "./api.ts";
import { aiApps, orbSecrets } from "./checks/apps.ts";
import { linkRot, mutation } from "./checks/artifacts.ts";
import { ciDuration, redBranch } from "./checks/ci-health.ts";
import { conformance } from "./checks/conformance.ts";
import {
  governanceDrift,
  nextGovernance,
  orgChecksRuleset,
} from "./checks/governance.ts";
import { captureScenes, webBuild } from "./checks/pipelines.ts";
import { advisories, packageSize, stuckRenovate } from "./checks/supply.ts";
import {
  staleRegistry,
  templateBehindLatest,
  templateCanary,
  templateMembership,
} from "./checks/templates.ts";
import { PartialFailure, type Check } from "./check.ts";
import { GardenContext } from "./context.ts";
import { applyPauses, plannedPauses } from "./pauses.ts";
import type { Finding, Report, Skipped } from "./types.ts";

const CHECKS: readonly Check[] = [
  conformance,
  redBranch,
  ciDuration,
  advisories,
  stuckRenovate,
  governanceDrift,
  nextGovernance,
  orgChecksRuleset,
  aiApps,
  orbSecrets,
  packageSize,
  mutation,
  templateBehindLatest,
  templateMembership,
  staleRegistry,
  templateCanary,
  webBuild,
  linkRot,
  captureScenes,
];

export interface Outcome {
  report: Report;
  /** Checks that could not run, as opposed to checks whose source does not exist yet. */
  failures: Skipped[];
}

function compare(a: { key: string }, b: { key: string }): number {
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

/** Runs every check, plans the pauses and applies them only when asked. */
export async function garden(
  api: GardenApi,
  options: { applyPauses: boolean; checks?: readonly Check[] },
): Promise<Outcome> {
  const context = new GardenContext(api);
  const found: Finding[] = [];
  const skipped: Skipped[] = [];
  const failures: Skipped[] = [];
  for (const check of options.checks ?? CHECKS) {
    try {
      const result = await check.run(context);
      if (result.kind === "findings") found.push(...result.findings);
      else skipped.push({ check: check.id, reason: result.reason });
    } catch (error) {
      const failure = {
        check: check.id,
        reason: error instanceof Error ? error.message : String(error),
      };
      if (error instanceof PartialFailure) found.push(...error.findings);
      skipped.push(failure);
      failures.push(failure);
    }
  }
  const findings = [
    ...new Map(found.map((entry) => [entry.key, entry])).values(),
  ].sort(compare);
  const pauses = (await plannedPauses(context, findings)).sort((a, b) =>
    a.repo < b.repo ? -1 : 1,
  );
  if (options.applyPauses) await applyPauses(api, pauses);
  return {
    report: {
      generatedAt: api.now().toISOString(),
      findings,
      pauses,
      skipped: skipped.sort((a, b) => (a.check < b.check ? -1 : 1)),
    },
    failures,
  };
}

/** One line per finding and per check that could not run; nothing when the org is clean. */
export function failureLines(outcome: Outcome): string[] {
  return [
    ...outcome.report.findings.map(
      (entry) =>
        `${entry.severity === "urgent" ? "URGENT " : ""}${entry.repo} ${entry.check} ${entry.subject}: ${entry.evidence}`,
    ),
    ...outcome.failures.map(
      (entry) => `${entry.check} could not run: ${entry.reason}`,
    ),
  ];
}
