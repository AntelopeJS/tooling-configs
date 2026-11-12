import { chmodSync } from "node:fs";
import { delimiter, join } from "node:path";

import { put } from "../../guardrails/helpers/test-repo.ts";

/** A fake program as a POSIX shell script and as the Windows batch file that does the same. */
export interface FakeScripts {
  sh: string;
  cmd: string;
}

/** Writes the fake program `name` into `folder`: the shell script, made executable, off Windows and `<name>.cmd` on it. */
export function installFake(
  folder: string,
  name: string,
  scripts: FakeScripts,
): void {
  if (process.platform === "win32") {
    put(folder, `${name}.cmd`, scripts.cmd.replace(/\r?\n/g, "\r\n"));
    return;
  }
  put(folder, name, scripts.sh);
  chmodSync(join(folder, name), 0o755);
}

/** Writes the fake program `name` into `folder` as a Node script that runs the same on every platform: `source` is CommonJS, started by the Node that runs the test. */
export function installNodeFake(
  folder: string,
  name: string,
  source: string,
): void {
  put(folder, `${name}.cjs`, source);
  installFake(folder, name, {
    sh: `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/${name}.cjs" "$@"\n`,
    cmd: `@"${process.execPath}" "%~dp0${name}.cjs" %*\n`,
  });
}

/** The PATH value that lists `folder` before the caller's own PATH. */
export function pathWith(folder: string): string {
  return `${folder}${delimiter}${process.env.PATH}`;
}
