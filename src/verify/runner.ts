import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

import { BUILTIN_JOURNEYS } from "./builtins.ts";
import { VerifyContext, type BuiltinJourney } from "./context.ts";
import { readFeatures } from "./map.ts";
import type { JourneyEnd, JourneyResult, JourneyStatus } from "./results.ts";
import type { Journey } from "./types.ts";
import type { RunState, Workspace } from "./workspace.ts";

/** Every journey id a feature file may name: the kind's built-in journeys and the repo's own. */
export function knownJourneys(
  workspace: Workspace,
): Map<string, BuiltinJourney | Journey> {
  return new Map<string, BuiltinJourney | Journey>([
    ...Object.entries(BUILTIN_JOURNEYS[workspace.kind]),
    ...Object.entries(workspace.config.journeys ?? {}),
  ]);
}

/** The journeys a feature file registers, in order. */
export function featureJourneys(
  workspace: Workspace,
  feature: string,
): string[] | undefined {
  return readFeatures(workspace).find((entry) => entry.name === feature)
    ?.journeys;
}

function resetServices(context: VerifyContext): void {
  for (const [name, service] of Object.entries(
    context.workspace.config.services ?? {},
  )) {
    if (!service.reset) continue;
    const container = context.service(name).container;
    const run = spawnSync("docker", ["exec", container, ...service.reset], {
      encoding: "utf8",
    });
    const folder = context.step(`reset ${name}`);
    writeFileSync(
      join(folder, "command.txt"),
      `docker exec ${container} ${service.reset.join(" ")}\n`,
    );
    writeFileSync(join(folder, "stdout.txt"), run.stdout ?? "");
    writeFileSync(join(folder, "stderr.txt"), run.stderr ?? "");
    context.expect(
      folder,
      [
        {
          name: `${name} reset to a clean state`,
          pass: run.status === 0,
          detail: `exit ${run.status}`,
        },
      ],
      { critical: true },
    );
  }
}

function statusOf(context: VerifyContext, failure: JourneyEnd): JourneyStatus {
  if (failure.notVerified !== null) return "NOT VERIFIED";
  const failed =
    failure.error !== null ||
    context.steps.some((step) => step.checks.some((check) => !check.pass));
  return failed || context.steps.length === 0 ? "FAIL" : "PASS";
}

async function runOne(
  workspace: Workspace,
  state: RunState,
  feature: string,
  id: string,
  journey: BuiltinJourney | Journey,
): Promise<JourneyResult> {
  const context = new VerifyContext(workspace, state, feature, id);
  let failure: JourneyEnd = {
    error: null,
    notVerified: null,
  };
  try {
    if (state.missingKeys.length > 0)
      context.notVerified(
        `provider sandbox keys missing from the environment: ${state.missingKeys.join(", ")}`,
      );
    resetServices(context);
    await journey.run(context);
  } catch (error) {
    failure = VerifyContext.reasonOf(
      error instanceof Error ? error : new Error(String(error)),
    );
  }
  await context.cleanup();
  const result: JourneyResult = {
    feature,
    journey: id,
    title: journey.title,
    entryPoint: journey.entryPoint,
    status: statusOf(context, failure),
    steps: context.steps,
    ...failure,
    folder: relative(state.evidence, context.folder),
  };
  writeFileSync(
    join(context.folder, "result.json"),
    `${JSON.stringify(result, null, 2)}\n`,
  );
  return result;
}

/** Reads the merged results of a feature in a run, if any journey of it ran. */
export function readResults(
  state: RunState,
  feature: string,
): JourneyResult[] | undefined {
  const file = join(state.evidence, feature, "feature.json");
  if (!existsSync(file)) return undefined;
  const results: JourneyResult[] = JSON.parse(readFileSync(file, "utf8"));
  return results;
}

/**
 * Runs the named journeys of a feature, or all of them, and merges their
 * results into feature.json so partial runs add up instead of overwriting.
 */
export async function runFeature(
  workspace: Workspace,
  state: RunState,
  feature: string,
  ids: string[],
): Promise<JourneyResult[]> {
  const registered = featureJourneys(workspace, feature);
  if (registered === undefined)
    throw new Error(`Unknown feature ${feature}: no features/${feature}.md`);
  const unknown = ids.filter((id) => !registered.includes(id));
  if (unknown.length > 0)
    throw new Error(
      `${feature} registers no journey ${unknown.join(", ")}; it registers ${registered.join(", ")}`,
    );
  const known = knownJourneys(workspace);
  const results: JourneyResult[] = [];
  for (const id of ids.length > 0 ? ids : registered) {
    const journey = known.get(id);
    if (journey === undefined)
      throw new Error(
        `${feature} names journey ${id}, which is neither built in nor in verify.config.ts journeys`,
      );
    results.push(await runOne(workspace, state, feature, id, journey));
  }
  const earlier = readResults(state, feature) ?? [];
  const merged = registered.flatMap((id) =>
    results
      .filter((result) => result.journey === id)
      .concat(
        results.some((result) => result.journey === id)
          ? []
          : earlier.filter((result) => result.journey === id),
      ),
  );
  writeFileSync(
    join(state.evidence, feature, "feature.json"),
    `${JSON.stringify(merged, null, 2)}\n`,
  );
  return results;
}
