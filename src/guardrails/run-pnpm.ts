import { spawnSync } from "node:child_process";

import { shimInvocation } from "./run-command.ts";

/** Runs pnpm, the only manager the pack's CI installs with, with `args` quietly; returns its output only when it failed. */
export function runPnpm(
  root: string,
  args: readonly string[],
): string | undefined {
  const command = ["pnpm", ...args].join(" ");
  const pnpm = shimInvocation("pnpm", args);
  const result = spawnSync(pnpm.command, pnpm.args, {
    cwd: root,
    encoding: "utf8",
    shell: pnpm.shell,
  });
  if (result.error) return `${command} failed: ${result.error.message}`;
  if (result.status === 0) return undefined;
  return `${command} failed (exit ${result.status}).\n${result.stdout}${result.stderr}`.trimEnd();
}
