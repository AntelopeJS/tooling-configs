import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { locateWindows } from "./exec.ts";
import { externalEnv, gitInit, lease, scratch } from "./helpers/cli.ts";

function filesAt(...paths: string[]): (path: string) => boolean {
  const present = new Set(paths);
  return (path) => present.has(path);
}

const PROGRAM_FILES = {
  Path: "C:\\bin;C:\\tools",
  PATHEXT: ".COM;.EXE;.BAT;.CMD;.VBS",
};

test("a command without an extension is found in a Path directory through PATHEXT, the variables spelled in any case (fails when the search joins the bare name, or reads only PATH)", () => {
  assert.deepEqual(
    locateWindows("node", PROGRAM_FILES, filesAt("C:\\tools\\node.exe")),
    { kind: "start", file: "C:\\tools\\node.exe", script: false },
  );
});

test("the first Path directory that holds a match wins, whatever extension it has (fails when the search tries every directory for one extension before the next extension)", () => {
  assert.deepEqual(
    locateWindows(
      "tool",
      PROGRAM_FILES,
      filesAt("C:\\bin\\tool.cmd", "C:\\tools\\tool.exe"),
    ),
    { kind: "start", file: "C:\\bin\\tool.cmd", script: true },
  );
});

test("a name with a directory or a drive is a path and skips the Path search, and one with a startable extension is used as it is (fails when a path is searched for in every Path directory, or gets .EXE appended)", () => {
  assert.deepEqual(
    locateWindows(
      "C:\\x\\tool.bat",
      PROGRAM_FILES,
      filesAt("C:\\x\\tool.bat", "C:\\bin\\C:\\x\\tool.bat"),
    ),
    { kind: "start", file: "C:\\x\\tool.bat", script: true },
  );
  assert.deepEqual(
    locateWindows(".\\tool", PROGRAM_FILES, filesAt(".\\tool.exe")),
    { kind: "start", file: ".\\tool.exe", script: false },
  );
});

test("a missing command is 127, and a file Windows cannot start is 126 naming the extensions that start (fails when a .vbs or .ps1 file reads as not found, or PATHEXT's .VBS is tried)", () => {
  assert.deepEqual(locateWindows("nope", PROGRAM_FILES, filesAt()), {
    kind: "refuse",
    code: 127,
    reason: "not found",
  });
  assert.deepEqual(
    locateWindows("C:\\x\\tool.ps1", PROGRAM_FILES, filesAt("C:\\x\\tool.ps1")),
    {
      kind: "refuse",
      code: 126,
      reason: "C:\\x\\tool.ps1 is not a .exe, .com, .bat or .cmd file",
    },
  );
  assert.deepEqual(
    locateWindows("tool", PROGRAM_FILES, filesAt("C:\\bin\\tool.vbs")),
    { kind: "refuse", code: 127, reason: "not found" },
  );
});

const windowsOnly =
  process.platform !== "win32" &&
  "starts programs through cmd.exe and the Windows Path, which exist on Windows only";

function pathFirst(directory: string, root: string): NodeJS.ProcessEnv {
  const env = externalEnv(join(root, ".home"));
  const rest = Object.fromEntries(
    Object.entries(env).filter(([key]) => key.toUpperCase() !== "PATH"),
  );
  const previous = Object.entries(env).find(
    ([key]) => key.toUpperCase() === "PATH",
  );
  return { ...rest, Path: `${directory};${previous?.[1] ?? ""}` };
}

test(
  "run starts a .cmd shim found through PATHEXT and hands it its arguments unchanged, and refuses an argument cmd.exe would rewrite with 126 (fails when run spawns the shim without cmd.exe, which Node refuses, or joins the arguments unquoted)",
  { skip: windowsOnly },
  async (t) => {
    const root = scratch(t);
    const worktree = gitInit(join(root, "w"));
    const printer = join(root, "print.cjs");
    writeFileSync(
      printer,
      "process.stdout.write(JSON.stringify(process.argv.slice(2)))",
    );
    writeFileSync(
      join(root, "shim.cmd"),
      `@echo off\r\n"${process.execPath}" "${printer}" %*\r\n`,
    );
    const env = pathFirst(root, root);
    const printed = await lease(
      ["run", "--", "shim", "a b", "*", "tail\\"],
      worktree,
      env,
    );
    assert.deepEqual(
      [printed.code, printed.stdout],
      [0, JSON.stringify(["a b", "*", "tail\\"])],
    );
    const refused = await lease(["run", "--", "shim", "50%"], worktree, env);
    assert.equal(refused.code, 126);
    assert.match(
      refused.stderr,
      /^antelopejs-lease: cannot run shim: .*cmd\.exe/u,
    );
  },
);
