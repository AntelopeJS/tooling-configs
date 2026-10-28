import type { GardenApi } from "./api.ts";
import { GardenContext, ORG } from "./context.ts";
import { redSince } from "./checks/ci-health.ts";
import { AUTOMERGE } from "./checks/governance.ts";
import type { Finding, Pause } from "./types.ts";

const PAUSED = "shadow";

function reasons(repo: string, findings: readonly Finding[]): string[] {
  const own = findings.filter((entry) => entry.repo === repo);
  return [
    ...(own.some(
      (entry) => entry.check === "conformance" && entry.subject === "ratchet",
    )
      ? ["the ratchet file is back on a Clean repository"]
      : []),
    ...(own.some((entry) => entry.check === "next-governance")
      ? ["governance drift"]
      : []),
  ];
}

/** Repositories where `NEXT_AUTOMERGE` is `on` and a stop-the-line trigger fired. */
export async function plannedPauses(
  context: GardenContext,
  findings: readonly Finding[],
): Promise<Pause[]> {
  const pauses: Pause[] = [];
  for (const repo of await context.scope()) {
    if ((await context.variable(repo, AUTOMERGE)) !== "on") continue;
    const triggers = reasons(repo.name, findings);
    const runs =
      (await context.targetBranch(repo)) === "next"
        ? await context.workflowRuns(repo, "ci.yml", "next")
        : undefined;
    if (runs !== undefined && redSince(runs) !== undefined)
      triggers.unshift("checks is red on next after a merge");
    if (triggers.length)
      pauses.push({
        repo: repo.name,
        from: "on",
        to: PAUSED,
        reason: triggers.join("; "),
      });
  }
  return pauses;
}

/** Writes the one repository variable and nothing else. */
export async function applyPauses(
  api: GardenApi,
  pauses: readonly Pause[],
): Promise<void> {
  for (const pause of pauses)
    await api.send(
      "PATCH",
      `/repos/${ORG}/${pause.repo}/actions/variables/${AUTOMERGE}`,
      { name: AUTOMERGE, value: pause.to },
    );
}
