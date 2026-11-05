import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { packageManager, parseManifest } from "./package.ts";
import { CEILINGS_FILE } from "./ceilings.ts";

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

/**
 * Runs every check step and reports only what failed. `skipSetting` is the comma-separated value of
 * `ANTELOPEJS_CHECKS_SKIP`: the steps it names are not run and are counted as skipped, never as passed, and a name that
 * is not a step fails the run before any step starts so a typo cannot skip nothing.
 */
export function runChecks(root: string, skipSetting = "") {
  const requested = skippedNames(skipSetting);
  const unknown = requested.filter((name) => !CHECK_STEPS.includes(name));
  if (unknown.length)
    return {
      failed: 1,
      output: `[${CHECKS_SKIP_ENV}]\nUnknown step ${unknown.map((name) => `"${name}"`).join(", ")}. Valid steps: ${CHECK_STEPS.join(", ")}.\nChecks: 0 passed, 1 failed.\n`,
    };
  const manifest = parseManifest(
    readFileSync(join(root, "package.json"), "utf8"),
  );
  const manager = packageManager(manifest);
  const failures: string[] = [];
  const present = CHECK_STEPS.filter(
    (step) => step !== "ratchet" || existsSync(join(root, CEILINGS_FILE)),
  );
  const steps = present.filter((step) => !requested.includes(step));
  const skipped = present.length - steps.length;
  for (const step of steps) {
    if (!manifest.scripts?.[step]) {
      failures.push(
        `[${step}] Missing package.json script "${step}". Run antelopejs-sync.\n`,
      );
      continue;
    }
    const result = spawnSync(manager, ["run", step], {
      cwd: root,
      encoding: "utf8",
      shell: process.platform === "win32",
      env: { ...process.env, CI: "1" },
      maxBuffer: 64 * 1024 * 1024,
    });
    if (result.status !== 0)
      failures.push(
        `[${step}]\n${result.stdout ?? ""}${result.stderr ?? ""}${result.error ? `${result.error.message}\n` : ""}${result.signal ? `Terminated by ${result.signal}\n` : ""}`,
      );
  }
  return {
    failed: failures.length,
    output: `${failures.join("\n")}Checks: ${steps.length - failures.length} passed, ${failures.length} failed${skipped ? `, ${skipped} skipped` : ""}.\n`,
  };
}
