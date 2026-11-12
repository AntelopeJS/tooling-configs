import { spawnSync } from "node:child_process";

/** Runs pnpm, the only manager the pack's CI installs with, with `args` quietly; returns its output only when it failed. */
export function runPnpm(
  root: string,
  args: readonly string[],
): string | undefined {
  const command = ["pnpm", ...args].join(" ");
  const result = spawnSync("pnpm", args, { cwd: root, encoding: "utf8" });
  if (result.error) return `${command} failed: ${result.error.message}`;
  if (result.status === 0) return undefined;
  return `${command} failed (exit ${result.status}).\n${result.stdout}${result.stderr}`.trimEnd();
}
