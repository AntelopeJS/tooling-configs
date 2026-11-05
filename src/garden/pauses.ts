import type { GardenApi } from "./api.ts";
import { GardenContext, ORG, type GardenRepo } from "./context.ts";
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

async function pauseFor(
  context: GardenContext,
  repo: GardenRepo,
  findings: readonly Finding[],
): Promise<Pause[]> {
  if ((await context.variable(repo, AUTOMERGE)) !== "on") return [];
  const triggers = reasons(repo.name, findings);
  const runs =
    (await context.targetBranch(repo)) === "next"
      ? await context.workflowRuns(repo, "ci.yml", "next")
      : undefined;
  if (runs !== undefined && redSince(runs) !== undefined)
    triggers.unshift("checks is red on next after a merge");
  return triggers.length
    ? [{ repo: repo.name, from: "on", to: PAUSED, reason: triggers.join("; ") }]
    : [];
}

/** Repositories where `NEXT_AUTOMERGE` is `on` and a stop-the-line trigger fired; a repository whose read failed is returned in `failed`, not paused. */
export async function plannedPauses(
  context: GardenContext,
  findings: readonly Finding[],
): Promise<{ pauses: Pause[]; failed: string[] }> {
  const pauses: Pause[] = [];
  const failed: string[] = [];
  const scope = await context.scope().catch((error: unknown) => {
    failed.push(
      `organization listing: ${error instanceof Error ? error.message : String(error)}`,
    );
    return [];
  });
  for (const repo of scope)
    await pauseFor(context, repo, findings).then(
      (found) => pauses.push(...found),
      (error: unknown) =>
        failed.push(
          `${repo.name}: ${error instanceof Error ? error.message : String(error)}`,
        ),
    );
  return { pauses, failed };
}

/** Writes the one repository variable and nothing else; a refused write does not stop the rest and is returned. */
export async function applyPauses(
  api: GardenApi,
  pauses: readonly Pause[],
): Promise<string[]> {
  const failed: string[] = [];
  for (const pause of pauses)
    await api
      .send(
        "PATCH",
        `/repos/${ORG}/${pause.repo}/actions/variables/${AUTOMERGE}`,
        { name: AUTOMERGE, value: pause.to },
      )
      .catch((error: unknown) => {
        failed.push(
          `${pause.repo}: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
  return failed;
}
