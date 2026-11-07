import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  type PackageManager,
  packageManager,
  parseManifest,
} from "./package.ts";
import { CEILINGS_FILE } from "./ceilings.ts";
import { runCommand } from "./run-command.ts";
import {
  type ServicesPlan,
  planServices,
  startServices,
  stopServices,
} from "./services.ts";
import {
  checkLockfiles,
  typecheckLayers,
  verifyLayers,
  verifyLockfiles,
} from "./verify-layers.ts";

const CHECK_STEPS = [
  "typecheck",
  "lint",
  "format:check",
  "knip",
  "test",
  "size",
  "ratchet",
  "suppressions",
  "sync:check",
  "verify:types",
  "verify:lockfiles",
];

/** Steps `antelopejs-checks` runs itself, no package.json script behind them: each returns what failed, empty when it passed. */
const OWN_STEPS = new Map<
  string,
  (
    root: string,
    manager: PackageManager,
    signal: AbortSignal | undefined,
  ) => Promise<string>
>([
  ["verify:types", typecheckLayers],
  [
    "verify:lockfiles",
    (root, _manager, signal) => checkLockfiles(root, signal),
  ],
]);

function hasWork(root: string, step: string): boolean {
  if (step === "ratchet") return existsSync(join(root, CEILINGS_FILE));
  if (step === "verify:types") return verifyLayers(root).length > 0;
  if (step === "verify:lockfiles") return verifyLockfiles(root).length > 0;
  return true;
}

/** The step that runs after the others, never beside them: tests often hold time limits that CPU contention would break. */
const RUNS_ALONE = "test";

/** The environment variable naming, comma-separated, the steps `runChecks` leaves to another CI job. */
export const CHECKS_SKIP_ENV = "ANTELOPEJS_CHECKS_SKIP";

function skippedNames(setting: string): string[] {
  return setting
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
}

/** Options of `runChecks`: the `ANTELOPEJS_CHECKS_SKIP` value, whether to manage the compose services, and an abort signal whose reason is the signal name that interrupted the run. */
export interface ChecksOptions {
  skipSetting?: string;
  services?: boolean;
  signal?: AbortSignal;
}

async function runSteps(
  root: string,
  manifest: ReturnType<typeof parseManifest>,
  steps: string[],
  signal: AbortSignal | undefined,
): Promise<string[]> {
  const manager = packageManager(manifest);
  const runStep = async (step: string): Promise<string[]> => {
    if (signal?.aborted) return [];
    const own = OWN_STEPS.get(step);
    if (own) {
      const failure = await own(root, manager, signal);
      return failure ? [`[${step}]\n${failure}`] : [];
    }
    if (!manifest.scripts?.[step])
      return [
        `[${step}] Missing package.json script "${step}". Run antelopejs-sync.\n`,
      ];
    const result = await runCommand(manager, ["run", step], {
      cwd: root,
      env: { ...process.env, CI: "1" },
      signal,
    });
    return result.status === 0 ? [] : [`[${step}]\n${result.output}`];
  };
  const failures = new Map<string, string[]>();
  await Promise.all(
    steps
      .filter((step) => step !== RUNS_ALONE)
      .map(async (step) => failures.set(step, await runStep(step))),
  );
  if (steps.includes(RUNS_ALONE))
    failures.set(RUNS_ALONE, await runStep(RUNS_ALONE));
  return steps.flatMap((step) => failures.get(step) ?? []);
}

function summary(failures: string[], passed: number, skipped: number): string {
  return `${failures.join("\n")}Checks: ${passed} passed, ${failures.length} failed${skipped ? `, ${skipped} skipped` : ""}.\n`;
}

/**
 * Runs every check step except `test` at the same time, then `test` alone, and reports only what failed, each step's
 * output buffered and listed in step order whichever step finishes first. `skipSetting` is the comma-separated value of
 * `ANTELOPEJS_CHECKS_SKIP`: the steps it names are not run and are counted as skipped, never as passed, and a name that
 * is not a step fails the run before any step starts so a typo cannot skip nothing. Unless `services` is false, the
 * services of `.github/compose.yml` are started before the steps when `test` runs, and removed after them if the run created them, also when a step fails or
 * `signal` aborts the run; an aborted run stops every running step and reports `interrupted`.
 */
export async function runChecks(root: string, options: ChecksOptions = {}) {
  const { skipSetting = "", services = true, signal } = options;
  const requested = skippedNames(skipSetting);
  const unknown = requested.filter((name) => !CHECK_STEPS.includes(name));
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
  const started =
    plan.kind === "start"
      ? await startServices(root, signal)
      : { failure: "", owned: false };
  let failures: string[] = [];
  let stopped = "";
  try {
    failures = started.failure
      ? [`[services]\n${started.failure}`]
      : await runSteps(root, manifest, steps, signal);
  } finally {
    if (started.owned) stopped = await stopServices(root);
  }
  const passed = started.failure ? 0 : steps.length - failures.length;
  if (stopped) failures.push(`[services]\n${stopped}`);
  const interrupted = signal?.aborted ?? false;
  return {
    failed: failures.length,
    interrupted,
    output: interrupted
      ? `${failures.join("\n")}Checks interrupted by ${String(signal?.reason)}.\n`
      : summary(failures, passed, skipped),
  };
}
