import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { packageManager, parseManifest } from "./package.ts";

export const CHECK_STEPS = [
  "typecheck",
  "lint",
  "format:check",
  "knip",
  "test",
  "size",
  "ratchet",
  "sync:check",
];

export function runChecks(root: string) {
  const manifest = parseManifest(
    readFileSync(join(root, "package.json"), "utf8"),
  );
  const manager = packageManager(manifest);
  const failures: string[] = [];
  for (const step of CHECK_STEPS) {
    if (!manifest.scripts?.[step]) {
      failures.push(
        `[${step}] Missing package.json script "${step}". Run antelopejs-sync.\n`,
      );
      continue;
    }
    const result = spawnSync(manager, ["run", step], {
      cwd: root,
      encoding: "utf8",
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
    output: `${failures.join("\n")}Checks: ${CHECK_STEPS.length - failures.length} passed, ${failures.length} failed.\n`,
  };
}
