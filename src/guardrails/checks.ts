import { readFileSync } from "node:fs";
import { join } from "node:path";

import { packageManager, parseManifest } from "./package.ts";
import {
  checkRepositoryRanges,
  hasDependencyRanges,
} from "./dependency-ranges-sync.ts";
import { checkGitIdentity, isGitCheckout } from "./git-identity.ts";
import { checkOneRange } from "./one-range.ts";
import { checkPublishedTypes, typedPackages } from "./published-types.ts";
import { checkReadmeVersion, readmeExamples } from "./readme-version.ts";
import { runCommand } from "./run-command.ts";
import {
  type ServicesPlan,
  planServices,
  startServices,
  stopServices,
} from "./services.ts";
import { checkSingletonPackages, pnpmLockfiles } from "./singleton-packages.ts";
import { typecheckWrites } from "./typecheck-writes.ts";

const CHECK_STEPS = [
  "typecheck",
  "lint",
  "format:check",
  "knip",
  "test",
  "size",
  "suppressions",
  "sync:check",
  "lockfile:singletons",
  "dependency:ranges",
  "dependency:one-range",
  "git:identity",
  "readme:version",
  "published:types",
];

/** What a step `antelopejs-checks` runs itself reports: what failed, empty when it passed, and notes printed either way. */
interface StepReport {
  failure: string;
  notes: string;
}

type OwnStep = (
  root: string,
  signal: AbortSignal | undefined,
) => Promise<StepReport>;

function failureOnly(
  check: (root: string, signal: AbortSignal | undefined) => Promise<string>,
): OwnStep {
  return async (root, signal) => ({
    failure: await check(root, signal),
    notes: "",
  });
}

/** Steps `antelopejs-checks` runs itself, no package.json script behind them. */
const OWN_STEPS = new Map<string, OwnStep>([
  [
    "lockfile:singletons",
    failureOnly((root) => Promise.resolve(checkSingletonPackages(root))),
  ],
  ["dependency:ranges", failureOnly(checkRepositoryRanges)],
  [
    "dependency:one-range",
    failureOnly((root) => Promise.resolve(checkOneRange(root))),
  ],
  ["git:identity", failureOnly(checkGitIdentity)],
  ["readme:version", failureOnly(checkReadmeVersion)],
  ["published:types", checkPublishedTypes],
]);

function hasWork(root: string, step: string): boolean {
  if (step === "lockfile:singletons") return pnpmLockfiles(root).length > 0;
  if (step === "dependency:ranges" || step === "dependency:one-range")
    return isGitCheckout(root) && hasDependencyRanges(root);
  if (step === "git:identity") return isGitCheckout(root);
  if (step === "readme:version") return readmeExamples(root).length > 0;
  if (step === "published:types") return typedPackages(root).length > 0;
  return true;
}

/** A command that runs a package script: the package manager, an optional `run`, then the script name. */
const SCRIPT_RUN =
  /^(?:pnpm|npm|yarn|bun)\s+(?:run(?:-script)?\s+)?([^\s-]\S*)/;

/**
 * The steps of `script`, a `checks` script sync replaces, that `antelopejs-checks` does not run: each command between
 * `&&`, `||` and `;` that is neither `antelopejs-checks` itself, a run of one of its steps or of `checks:prepare`, nor
 * the very command one of those holds in `scripts`, the scripts sync writes. A run of another package script is named
 * by that script, any other command by its text.
 */
function stepsNotRun(
  script: string,
  scripts: Readonly<Record<string, string>>,
): string[] {
  const run = new Set([...CHECK_STEPS, PREPARE]);
  const held = new Set(
    [...run].flatMap((step) =>
      Object.hasOwn(scripts, step) ? [scripts[step]] : [],
    ),
  );
  return script
    .split(/&&|\|\||;/)
    .map((command) => command.trim())
    .filter(
      (command) =>
        command &&
        !/(?:^|\s)antelopejs-checks$/.test(command) &&
        !held.has(command),
    )
    .flatMap((command) => {
      const name = SCRIPT_RUN.exec(command)?.[1];
      if (name !== undefined && run.has(name)) return [];
      return name !== undefined && Object.hasOwn(scripts, name)
        ? [name]
        : [command];
    });
}

/** The sync note naming the steps of the `checks` script in the package.json text `current` that the one in `synced`, the text sync writes, replaces and does not run; none when the script is kept or loses no step. */
export function droppedChecksSteps(
  current: string | undefined,
  synced: string,
): string[] {
  const previous = parseManifest(current ?? "{}").scripts?.checks;
  const scripts = parseManifest(synced).scripts ?? {};
  const command = scripts.checks;
  if (previous === undefined || previous === command) return [];
  const dropped = stepsNotRun(previous, scripts);
  if (!dropped.length) return [];
  return [
    `package.json: the checks script now runs ${command}, which does not run ${dropped.map((step) => `"${step}"`).join(", ")} from the replaced script. Call each from one of its steps, such as test or lint, or it no longer runs in checks.`,
  ];
}

/**
 * The steps that run after the others, each alone and in this order: tests often hold time limits that CPU contention
 * would break, and `published:types` packs each package, whose `prepack` rebuilds the output other steps and tests read.
 */
const RUNS_ALONE = ["test", "published:types"];

/** The step that runs before the others when it writes files, such as a workspace package's `dist`, that they read. */
const RUNS_FIRST = "typecheck";

/** The groups of steps that run one after another, the steps of a group at the same time. */
function phases(root: string, steps: readonly string[]): string[][] {
  const first =
    steps.includes(RUNS_FIRST) && typecheckWrites(root) ? [RUNS_FIRST] : [];
  const alone = RUNS_ALONE.filter((step) => steps.includes(step));
  const together = steps.filter(
    (step) => !first.includes(step) && !alone.includes(step),
  );
  return [first, together, ...alone.map((step) => [step])].filter(
    (phase) => phase.length > 0,
  );
}

/** The environment variable naming, comma-separated, the steps `runChecks` leaves to another CI job. */
export const CHECKS_SKIP_ENV = "ANTELOPEJS_CHECKS_SKIP";

/** The environment variable holding the CI tier the shared workflow picked: `fast`, `full`, `queue` or `nightly`, or the legacy `draft`. */
export const CI_TIER_ENV = "ANTELOPEJS_CI_TIER";

/** The steps that read the npm registry, which the pull request tiers leave to the merge queue and the nightly run. */
const REGISTRY_STEPS = [
  "dependency:ranges",
  "readme:version",
  "published:types",
];

const TIER_SKIPS = new Map([
  ["draft", REGISTRY_STEPS],
  ["fast", REGISTRY_STEPS],
  ["full", REGISTRY_STEPS],
]);

function tierSkips(tier: string | undefined): string[] {
  return TIER_SKIPS.get(tier ?? "") ?? [];
}

function skippedNames(setting: string): string[] {
  return setting
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
}

/** Options of `runChecks`: the `ANTELOPEJS_CHECKS_SKIP` value, the `ANTELOPEJS_CI_TIER` value, whether to manage the compose services, and an abort signal whose reason is the signal name that interrupted the run. */
export interface ChecksOptions {
  skipSetting?: string;
  tier?: string;
  services?: boolean;
  signal?: AbortSignal;
}

async function runSteps(
  root: string,
  manifest: ReturnType<typeof parseManifest>,
  steps: string[],
  signal: AbortSignal | undefined,
): Promise<{ failures: string[]; notes: string[] }> {
  const manager = packageManager(manifest);
  const runStep = async (step: string): Promise<StepReport> => {
    if (signal?.aborted) return { failure: "", notes: "" };
    const own = OWN_STEPS.get(step);
    if (own) {
      const { failure, notes } = await own(root, signal);
      return {
        failure: failure && `[${step}]\n${failure}`,
        notes: notes && `[${step}]\n${notes}`,
      };
    }
    if (!manifest.scripts?.[step])
      return {
        failure: `[${step}] Missing package.json script "${step}". Run antelopejs-sync.\n`,
        notes: "",
      };
    const result = await runCommand(manager, ["run", step], {
      cwd: root,
      env: { ...process.env, CI: "1" },
      signal,
    });
    return {
      failure: result.status === 0 ? "" : `[${step}]\n${result.output}`,
      notes: "",
    };
  };
  const reports = new Map<string, StepReport>();
  for (const phase of phases(root, steps))
    await Promise.all(
      phase.map(async (step) => reports.set(step, await runStep(step))),
    );
  const listed = (field: keyof StepReport) =>
    steps.flatMap((step) => reports.get(step)?.[field] || []);
  return { failures: listed("failure"), notes: listed("notes") };
}

/** The optional package script run once before the steps, to build what several steps read, such as a workspace package's `dist`. */
const PREPARE = "checks:prepare";

/** Runs `checks:prepare` when the manifest has it: the run's result when it failed or `signal` aborted it, else undefined. */
async function prepare(
  root: string,
  manifest: ReturnType<typeof parseManifest>,
  signal: AbortSignal | undefined,
) {
  if (!manifest.scripts?.[PREPARE]) return undefined;
  const result = await runCommand(packageManager(manifest), ["run", PREPARE], {
    cwd: root,
    env: { ...process.env, CI: "1" },
    signal,
  });
  const failure = result.status === 0 ? "" : `[${PREPARE}]\n${result.output}`;
  if (signal?.aborted)
    return {
      failed: failure ? 1 : 0,
      interrupted: true,
      output: `${failure}Checks interrupted by ${String(signal.reason)}.\n`,
    };
  if (failure)
    return {
      failed: 1,
      interrupted: false,
      output: `${failure}Checks: 0 passed, 1 failed.\n`,
    };
  return undefined;
}

function summary(
  reported: string,
  failed: number,
  passed: number,
  skipped: number,
): string {
  return `${reported}Checks: ${passed} passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ""}.\n`;
}

/**
 * Runs the `checks:prepare` package script first when it exists and a step will run, and stops there if it fails.
 * Then runs `typecheck` first when it writes files the other steps read (see `typecheckWrites`), every other check step
 * except `test` and `published:types` at the same time, then each of those alone, and reports only what failed, each step's
 * output buffered and listed in step order whichever step finishes first. `skipSetting` is the comma-separated value of
 * `ANTELOPEJS_CHECKS_SKIP`: the steps it names are not run and are counted as skipped, never as passed, and a name that
 * is not a step fails the run before any step starts so a typo cannot skip nothing. On the `draft`, `fast` and `full` tiers of
 * `tier`, the steps that read the npm registry, `dependency:ranges`, `readme:version` and `published:types`, are skipped the same way;
 * the `queue` and `nightly` tiers, and no tier, run them. Unless `services` is false, the
 * services of `.github/compose.yml` are started before the steps when `test` runs, and removed after them if the run created them, also when a step fails or
 * `signal` aborts the run; an aborted run stops every running step and reports `interrupted`.
 */
export async function runChecks(root: string, options: ChecksOptions = {}) {
  const { skipSetting = "", tier, services = true, signal } = options;
  const requested = skippedNames(skipSetting);
  const unknown = requested.filter((name) => !CHECK_STEPS.includes(name));
  requested.push(...tierSkips(tier));
  if (unknown.length)
    return {
      failed: 1,
      interrupted: false,
      output: `[${CHECKS_SKIP_ENV}]\nUnknown step ${unknown.map((name) => `"${name}"`).join(", ")}. Valid steps: ${CHECK_STEPS.join(", ")}.\nChecks: 0 passed, 1 failed.\n`,
    };
  const present = CHECK_STEPS.filter((step) => hasWork(root, step));
  const steps = present.filter((step) => !requested.includes(step));
  const skipped = present.length - steps.length;
  const manifest = parseManifest(
    readFileSync(join(root, "package.json"), "utf8"),
  );
  const plan: ServicesPlan =
    services && steps.includes("test")
      ? await planServices(root)
      : { kind: "none" };
  if (plan.kind === "unavailable")
    return {
      failed: 1,
      interrupted: false,
      output: `[services]\n${plan.output}Checks: 0 passed, 1 failed.\n`,
    };
  const unprepared = steps.length
    ? await prepare(root, manifest, signal)
    : undefined;
  if (unprepared) return unprepared;
  const started =
    plan.kind === "start"
      ? await startServices(root, signal)
      : { failure: "", owned: false };
  let failures: string[] = [];
  let notes: string[] = [];
  let stopped = "";
  try {
    if (started.failure) failures = [`[services]\n${started.failure}`];
    else ({ failures, notes } = await runSteps(root, manifest, steps, signal));
  } finally {
    if (started.owned) stopped = await stopServices(root);
  }
  const passed = started.failure ? 0 : steps.length - failures.length;
  if (stopped) failures.push(`[services]\n${stopped}`);
  const interrupted = signal?.aborted ?? false;
  const reported = [...notes, ...failures].join("\n");
  return {
    failed: failures.length,
    interrupted,
    output: interrupted
      ? `${reported}Checks interrupted by ${String(signal?.reason)}.\n`
      : summary(reported, failures.length, passed, skipped),
  };
}
