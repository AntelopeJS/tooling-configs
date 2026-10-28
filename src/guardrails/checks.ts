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

export function runChecks(root: string) {
  const manifest = parseManifest(
    readFileSync(join(root, "package.json"), "utf8"),
  );
  const manager = packageManager(manifest);
  const failures: string[] = [];
  const steps = CHECK_STEPS.filter(
    (step) => step !== "ratchet" || existsSync(join(root, CEILINGS_FILE)),
  );
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
    output: `${failures.join("\n")}Checks: ${steps.length - failures.length} passed, ${failures.length} failed.\n`,
  };
}
