import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";

/** Writes `body` as the Node program `name` in `directory`, run by its name from PATH: a shebang script, or on Windows a `.js` file behind the `.cmd` shim cmd.exe resolves. */
export function writeTool(directory: string, name: string, body: string): void {
  if (process.platform !== "win32") {
    writeFileSync(join(directory, name), `#!${process.execPath}\n${body}\n`);
    chmodSync(join(directory, name), 0o755);
    return;
  }
  writeFileSync(join(directory, `${name}.js`), `${body}\n`);
  writeFileSync(
    join(directory, `${name}.cmd`),
    `@"${process.execPath}" "%~dp0${name}.js" %*\r\n`,
  );
}

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
