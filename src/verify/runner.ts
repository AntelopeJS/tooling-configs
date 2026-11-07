import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";

import { BUILTIN_JOURNEYS } from "./builtins.ts";
import { VerifyContext, type BuiltinJourney } from "./context.ts";
import { readFeatures } from "./map.ts";
import { killGroup, onInterrupt } from "./record.ts";
import type { JourneyEnd, JourneyResult, JourneyStatus } from "./results.ts";
import type { Journey } from "./types.ts";
import {
  git,
  removeTree,
  saveRun,
  type RunState,
  type Workspace,
} from "./workspace.ts";

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

/** Deletes a journey's scratch folder and HOME, and their parents once empty; the evidence stays. A folder it cannot delete is reported on stderr and left for the next prune. */
function discard(context: VerifyContext): void {
  for (const folder of [context.work, context.home]) {
    try {
      removeTree(folder);
      for (
        let parent = dirname(folder);
        parent !== context.state.dir && readdirSync(parent).length === 0;
        parent = dirname(parent)
      )
        rmdirSync(parent);
    } catch (error) {
      process.stderr.write(
        `could not delete ${folder}: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  }
}

async function runOne(
  workspace: Workspace,
  state: RunState,
  feature: string,
  id: string,
  journey: BuiltinJourney | Journey,
): Promise<JourneyResult> {
  const context = new VerifyContext(workspace, state, feature, id);
  const others = new Set(state.processes.map((record) => record.pid));
  const release = onInterrupt(() => {
    const own = state.processes.filter((record) => !others.has(record.pid));
    for (const record of own) killGroup(record.pid);
    discard(context);
    state.processes = state.processes.filter((record) =>
      others.has(record.pid),
    );
    saveRun(state);
  });
  try {
    return await driveJourney(context, feature, id, journey);
  } finally {
    release();
    discard(context);
  }
}

async function driveJourney(
  context: VerifyContext,
  feature: string,
  id: string,
  journey: BuiltinJourney | Journey,
): Promise<JourneyResult> {
  const { state } = context;
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
  if (statusOf(context, failure) === "FAIL") {
    const fault = await context.environmentFault();
    if (fault !== null) failure = { ...failure, notVerified: fault };
  }
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

/** NUL-separated paths git prints, read without the default output limit, since a large worktree can list megabytes. */
function gitPaths(root: string, args: string[]): string[] {
  const listed = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 1024,
  });
  if (listed.status !== 0) throw new Error(`git ${args.join(" ")} failed`);
  return listed.stdout.split("\0").filter(Boolean);
}

/**
 * A fingerprint of the tree a journey runs against: HEAD, and the path, type,
 * size and modification time of every changed tracked file and every
 * untracked, non-ignored entry. It never reads file contents, so symlinks,
 * nested repositories and huge files cost one `lstat` each; an edit always
 * moves the modification time. The run's own folder is left out when it sits
 * inside the repository, since its evidence changes with every journey.
 * `undefined` when git cannot answer, which disables reuse instead of failing
 * the journey.
 */
function treeState(root: string, runDir: string): string | undefined {
  try {
    const own = relative(root, runDir);
    const inside =
      own !== "" && !own.startsWith("..") && !isAbsolute(own)
        ? `${own}/`
        : null;
    const hash = createHash("sha256");
    hash.update(git(root, ["rev-parse", "HEAD"]));
    const paths = [
      ...gitPaths(root, ["diff", "HEAD", "--name-only", "-z", "--no-renames"]),
      ...gitPaths(root, ["ls-files", "-z", "--others", "--exclude-standard"]),
    ]
      .filter((path) => inside === null || !`${path}/`.startsWith(inside))
      .sort();
    for (const path of paths) {
      const stat = lstatSync(join(root, path), {
        bigint: true,
        throwIfNoEntry: false,
      });
      hash.update(
        `\0${path}\0${stat === undefined ? "gone" : `${stat.mode}:${stat.size}:${stat.mtimeNs}`}`,
      );
    }
    return hash.digest("hex");
  } catch {
    return undefined;
  }
}

/** The PASS of journey `id` that another feature of this run recorded by running it against the same tree, if any. */
function passElsewhere(
  state: RunState,
  feature: string,
  id: string,
  tree: string,
): JourneyResult | undefined {
  const features = readdirSync(state.evidence, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== feature)
    .map((entry) => entry.name)
    .sort();
  for (const other of features) {
    const source = readResults(state, other)?.find(
      (result) =>
        result.journey === id &&
        result.status === "PASS" &&
        result.reusedFrom === undefined &&
        result.tree === tree,
    );
    if (source !== undefined) return source;
  }
  return undefined;
}

/** Records the tree a journey ran against in its result.json. */
function stamp(
  state: RunState,
  result: JourneyResult,
  tree: string | undefined,
): JourneyResult {
  if (tree === undefined) return result;
  const stamped = { ...result, tree };
  writeFileSync(
    join(state.evidence, result.folder, "result.json"),
    `${JSON.stringify(stamped, null, 2)}\n`,
  );
  return stamped;
}

/** Records `source` as the result of `id` under `feature` without running the journey: its own result.json names the folder it reuses. */
function reuse(
  state: RunState,
  feature: string,
  id: string,
  source: JourneyResult,
): JourneyResult {
  const folder = join(state.evidence, feature, id);
  rmSync(folder, { recursive: true, force: true });
  mkdirSync(folder, { recursive: true });
  const result: JourneyResult = {
    ...source,
    feature,
    folder: relative(state.evidence, folder),
    reusedFrom: source.folder,
  };
  writeFileSync(
    join(folder, "result.json"),
    `${JSON.stringify(result, null, 2)}\n`,
  );
  return result;
}

/**
 * Runs the named journeys of a feature, or all of them, and merges their
 * results into feature.json so partial runs add up instead of overwriting.
 *
 * A journey id is the same code whichever feature lists it. When no ids are
 * named, a journey that another feature of this run already ran and passed
 * is not run again: the feature records a result that reuses that PASS and
 * names its evidence folder. Only a PASS is reused, only for the same tree
 * (HEAD, uncommitted diff and untracked files) and while HEAD is still the
 * commit the run was created at, never across runs, and never for a
 * journey this feature already has a result for. Naming ids runs them even
 * when a PASS exists.
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
  const earlier = readResults(state, feature) ?? [];
  const tree = treeState(workspace.root, state.dir);
  const mayReuse =
    ids.length === 0 &&
    git(workspace.root, ["rev-parse", "HEAD"]) === state.headSha;
  const results: JourneyResult[] = [];
  for (const id of ids.length > 0 ? ids : registered) {
    const journey = known.get(id);
    if (journey === undefined)
      throw new Error(
        `${feature} names journey ${id}, which is neither built in nor in verify.config.ts journeys`,
      );
    const source =
      mayReuse &&
      tree !== undefined &&
      !earlier.some((result) => result.journey === id)
        ? passElsewhere(state, feature, id, tree)
        : undefined;
    results.push(
      source === undefined
        ? stamp(
            state,
            await runOne(workspace, state, feature, id, journey),
            tree,
          )
        : reuse(state, feature, id, source),
    );
  }
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
