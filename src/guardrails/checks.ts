import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { packageManager, parseManifest } from "./package.ts";
import { CEILINGS_FILE } from "./ceilings.ts";
import { runCommand } from "./run-command.ts";
import {
  type ServicesPlan,
  planServices,
  startServices,
  stopServices,
} from "./services.ts";

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
];

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
  const failures: string[] = [];
  for (const step of steps) {
    if (signal?.aborted) break;
    if (!manifest.scripts?.[step]) {
      failures.push(
        `[${step}] Missing package.json script "${step}". Run antelopejs-sync.\n`,
      );
      continue;
    }
    const result = await runCommand(manager, ["run", step], {
      cwd: root,
      env: { ...process.env, CI: "1" },
      signal,
    });
    if (result.status !== 0) failures.push(`[${step}]\n${result.output}`);
  }
  return failures;
}

function summary(failures: string[], passed: number, skipped: number): string {
  return `${failures.join("\n")}Checks: ${passed} passed, ${failures.length} failed${skipped ? `, ${skipped} skipped` : ""}.\n`;
}

/**
 * Runs every check step and reports only what failed. `skipSetting` is the comma-separated value of
 * `ANTELOPEJS_CHECKS_SKIP`: the steps it names are not run and are counted as skipped, never as passed, and a name that
 * is not a step fails the run before any step starts so a typo cannot skip nothing. Unless `services` is false, the
 * services of `.github/compose.yml` are started before the steps when `test` runs, and removed after them if the run created them, also when a step fails or
 * `signal` aborts the run; an aborted run stops the running step and reports `interrupted`.
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
  const present = CHECK_STEPS.filter(
    (step) => step !== "ratchet" || existsSync(join(root, CEILINGS_FILE)),
  );
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
