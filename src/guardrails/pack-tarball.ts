import { type CommandResult, runCommand } from "./run-command.ts";

/** The flag that stops `pack` from running lifecycle scripts, by package manager. */
const IGNORE_SCRIPTS: Record<"pnpm" | "npm", string> = {
  pnpm: "--config.ignore-scripts=true",
  npm: "--ignore-scripts",
};

/**
 * The arguments to `manager` that pack the package in the working directory into `destination`, in order: its `prepack`
 * through `<manager> run`, which uses the configured script shell, then `<manager> pack` with lifecycle scripts off,
 * since `pnpm pack` runs them through cmd.exe on Windows whatever the script shell, so a POSIX `prepare` fails there.
 * Stop at the first that fails.
 */
export function packSteps(
  manager: "pnpm" | "npm",
  destination: string,
): readonly [prepack: string[], pack: string[]] {
  return [
    ["run", "--if-present", "prepack"],
    ["pack", IGNORE_SCRIPTS[manager], "--pack-destination", destination],
  ];
}

/** Packs the package in `cwd` into `destination` through {@link packSteps}. Returns the first failed command, else the pack. */
export async function packTarball(
  manager: "pnpm" | "npm",
  cwd: string,
  destination: string,
  signal?: AbortSignal,
): Promise<CommandResult> {
  const [prepackArgs, packArgs] = packSteps(manager, destination);
  const prepack = await runCommand(manager, prepackArgs, { cwd, signal });
  if (prepack.status !== 0) return prepack;
  return runCommand(manager, packArgs, { cwd, signal });
}
