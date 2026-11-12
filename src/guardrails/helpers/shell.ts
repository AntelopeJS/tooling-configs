import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

/** The first `name` on `PATH`, with `.exe` on Windows, as a shell resolves it. */
export function onPath(name: string): string {
  const file = process.platform === "win32" ? `${name}.exe` : name;
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (directory && existsSync(join(directory, file)))
      return join(directory, file);
  }
  throw new Error(`${name} is not on PATH.`);
}

/** The POSIX shell package scripts run in: `/bin/sh`, or on Windows the Git Bash `sh` on `PATH`. */
const SH = process.platform === "win32" ? onPath("sh") : "/bin/sh";

/** Runs `script` with {@link SH} in `cwd`, with `directories` before the inherited `PATH`, and `env` on top. */
export function runScript(
  script: string,
  cwd: string,
  directories: readonly string[],
  env: NodeJS.ProcessEnv = {},
) {
  return spawnSync(SH, ["-c", script], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: [...directories, process.env.PATH ?? ""].join(delimiter),
      ...env,
    },
  });
}
