import { type CommandResult, runCommand } from "./run-command.ts";

/** The flag that stops `pack` from running lifecycle scripts, by package manager. */
const IGNORE_SCRIPTS: Record<"pnpm" | "npm", string> = {
  pnpm: "--config.ignore-scripts=true",
  npm: "--ignore-scripts",
};

/**
 * Packs the package in `cwd` into `destination`: runs its `prepack` through `<manager> run`, which uses the configured
 * script shell, then `<manager> pack` with lifecycle scripts off, since `pnpm pack` runs them through cmd.exe on Windows
 * whatever the script shell, so a POSIX `prepare` fails there. Returns the first failed command, else the pack.
 */
export async function packTarball(
  manager: "pnpm" | "npm",
  cwd: string,
  destination: string,
  signal?: AbortSignal,
): Promise<CommandResult> {
  const prepack = await runCommand(
    manager,
    ["run", "--if-present", "prepack"],
    { cwd, signal },
  );
  if (prepack.status !== 0) return prepack;
  return runCommand(
    manager,
    ["pack", IGNORE_SCRIPTS[manager], "--pack-destination", destination],
    { cwd, signal },
  );
}
