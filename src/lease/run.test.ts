import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  externalEnv,
  firstLine,
  gitInit,
  lease,
  LEASE_ARGV,
  scratch,
  startCaptured,
  type Outcome,
} from "./helpers/cli.ts";
import {
  child,
  object,
  parseJson,
  strings,
  type JsonValue,
} from "../garden/json.ts";

/** The variables `run` adds, from the table in docs/agent-worktrees.md. */
const LEASE_VARIABLES = [
  "ANTELOPEJS_LEASE",
  "ANTELOPEJS_LEASE_DIR",
  "ANTELOPEJS_LEASE_PARENT_TMPDIR",
  "DMS_BACK_LOG",
  "DMS_BACK_PORT",
  "DMS_CLIENT_BASE_URL",
  "DMS_FRONT_LOG",
  "DMS_FRONT_PORT",
  "DMS_INSPECT_PORT",
  "DMS_SMTP_PORT",
  "MONGO_DATABASE",
  "MONGO_URL",
  "TMPDIR",
];

/** Prints the whole environment and the arguments the command got, as one JSON object. */
const PRINT_ENV_AND_ARGS = `process.stdout.write(JSON.stringify({ env: process.env, args: process.argv.slice(1) }))`;

/** Prints `ready`, then, half a second after the first signal, how often each signal arrived. */
const COUNT_SIGNALS = `const counts = {};
let timer;
for (const name of ["SIGINT", "SIGTERM", "SIGHUP"])
  process.on(name, () => {
    counts[name] = (counts[name] ?? 0) + 1;
    timer ??= setTimeout(() => {
      console.log(JSON.stringify(counts));
      process.exit(0);
    }, 500);
  });
console.log("ready");
setInterval(() => {}, 1000);
`;

/** The variables libuv adds from its own environment to every process Node starts on Windows, when the one it passes lacks them. */
const LIBUV_WINDOWS_VARIABLES = [
  "HOMEDRIVE",
  "HOMEPATH",
  "LOGONSERVER",
  "SYSTEMDRIVE",
  "TEMP",
  "USERDOMAIN",
  "USERNAME",
  "USERPROFILE",
  "WINDIR",
];

const POSIX_SIGNALS =
  process.platform === "win32" &&
  "Windows has no POSIX signals or process groups: run is the parent of its command there, and Ctrl+C reaches both through the console";

const POSIX_EXEC =
  process.platform === "win32" &&
  "Windows has no execute permission bit, #! line or /bin/sh: a file is a program by its .exe, .com, .bat or .cmd extension";

interface Setup {
  readonly worktree: string;
  readonly env: NodeJS.ProcessEnv;
  readonly argv: readonly string[];
}

function setup(t: test.TestContext): Setup {
  const root = scratch(t);
  const counter = join(root, "count.cjs");
  writeFileSync(counter, COUNT_SIGNALS);
  return {
    worktree: gitInit(join(root, "w")),
    env: externalEnv(join(root, ".home")),
    argv: [...LEASE_ARGV, "run", "--", process.execPath, counter],
  };
}

function counts(outcome: Outcome): JsonValue {
  const printed = /\{[^}]*\}/u.exec(outcome.stdout)?.[0];
  if (printed === undefined)
    throw new Error(`no counts printed: ${JSON.stringify(outcome)}`);
  return parseJson(printed);
}

function quote(word: string): string {
  return `'${word.replaceAll("'", "'\\''")}'`;
}

const hasScript = (() => {
  try {
    execFileSync("script", ["--version"], { stdio: "ignore" });
    return process.platform === "linux";
  } catch {
    return false;
  }
})();

test(
  "Ctrl-C in a terminal reaches the command once (fails when run forwards SIGINT to a command that the terminal already signalled, so tools that force-quit on a second Ctrl-C skip their cleanup)",
  { skip: !hasScript && "needs util-linux script for a pseudo-terminal" },
  async (t) => {
    const { worktree, env, argv } = setup(t);
    const terminal = startCaptured(
      "script",
      ["-qec", argv.map(quote).join(" "), "/dev/null"],
      { cwd: worktree, env, stdio: ["pipe", "pipe", "pipe"] },
    );
    t.after(() => terminal.child.kill("SIGKILL"));
    assert.equal(await firstLine(terminal), "ready");
    terminal.child.stdin?.write("\u0003");
    const outcome = await terminal.done;
    assert.deepEqual(counts(outcome), { SIGINT: 1 });
  },
);

test(
  "a SIGTERM to run's whole process group reaches the command once (fails when run forwards a signal its command also got from the group kill)",
  { skip: POSIX_SIGNALS },
  async (t) => {
    const { worktree, env, argv } = setup(t);
    const [file = "", ...args] = argv;
    const group = startCaptured(file, args, {
      cwd: worktree,
      env,
      detached: true,
    });
    t.after(() => group.child.kill("SIGKILL"));
    assert.equal(await firstLine(group), "ready");
    process.kill(-(group.child.pid ?? 0), "SIGTERM");
    assert.deepEqual(counts(await group.done), { SIGTERM: 1 });
  },
);

test(
  "a SIGTERM to the pid of run reaches the command once (fails when run neither forwards nor becomes the command, so a direct kill never reaches it)",
  { skip: POSIX_SIGNALS },
  async (t) => {
    const { worktree, env, argv } = setup(t);
    const [file = "", ...args] = argv;
    const direct = startCaptured(file, args, { cwd: worktree, env });
    t.after(() => direct.child.kill("SIGKILL"));
    assert.equal(await firstLine(direct), "ready");
    direct.child.kill("SIGTERM");
    assert.deepEqual(counts(await direct.done), { SIGTERM: 1 });
  },
);

test(
  "run exits 128 plus the signal for a command a signal killed (fails when run reports its own status instead of the command's)",
  { skip: POSIX_SIGNALS },
  async (t) => {
    const { worktree, env } = setup(t);
    const killed = await startCaptured(
      "sh",
      [
        "-c",
        '"$@" run -- sh -c \'kill -TERM $$\'; echo "exit $?"',
        "sh",
        ...LEASE_ARGV,
      ],
      { cwd: worktree, env },
    ).done;
    assert.equal(killed.stdout.trim(), "exit 143");
  },
);

test("run exits with its command's code, and 127 for a missing one (fails when run reports its own status instead of the command's)", async (t) => {
  const { worktree, env } = setup(t);
  assert.equal(
    (
      await lease(
        ["run", "--", process.execPath, "-e", "process.exit(7)"],
        worktree,
        env,
      )
    ).code,
    7,
  );
  const missing = await lease(
    ["run", "--", "no-such-command-xyz"],
    worktree,
    env,
  );
  assert.equal(missing.code, 127);
  assert.match(
    missing.stderr,
    /antelopejs-lease: cannot run no-such-command-xyz/u,
  );
});

test("run hands its command the caller's environment and arguments unchanged, without PORT and with the lease variables (fails when run execs through a shell, which drops names such as A-B and BASH_FUNC_f%%, rewrites IFS, OPTIND and PPID, or adds PWD)", async (t) => {
  const root = scratch(t);
  const worktree = gitInit(join(root, "w"));
  const caller = {
    PATH: process.env.PATH ?? "",
    ...(process.platform === "win32" && {
      SystemRoot: process.env.SystemRoot ?? "",
    }),
    ANTELOPEJS_LEASE_HOME: join(root, ".home"),
    DMS_MONGO_URL: "mongodb://127.0.0.1:1",
    PORT: "5010",
    "A-B": "1",
    "x.y": "2",
    "1X": "3",
    "BASH_FUNC_f%%": "() {  echo f\n}",
    IFS: ":",
    OPTIND: "9",
    PPID: "1",
    QUOTED: `a 'b' "c" $d\ne`,
  };
  const args = ["a b", "*", "$HOME", "'q'", ""];
  const outcome = await lease(
    ["run", "--", process.execPath, "-e", PRINT_ENV_AND_ARGS, ...args],
    worktree,
    caller,
  );
  assert.equal(outcome.code, 0, outcome.stderr);
  const printed = object(parseJson(outcome.stdout), "printed");
  const env = child(printed, "env");
  const leased = Object.fromEntries(
    Object.entries(env).filter(([key]) => LEASE_VARIABLES.includes(key)),
  );
  const { PORT: _port, ...kept } = caller;
  const named = new Set(Object.keys(caller).map((key) => key.toUpperCase()));
  const received = Object.fromEntries(
    Object.entries(env).filter(
      ([key]) =>
        process.platform !== "win32" ||
        !LIBUV_WINDOWS_VARIABLES.includes(key) ||
        named.has(key),
    ),
  );
  assert.deepEqual(Object.keys(leased).sort(), LEASE_VARIABLES);
  assert.deepEqual(received, { ...kept, ...leased });
  assert.deepEqual(strings(printed, "args"), args);
});

test(
  "run exits 126 for a command it finds but cannot execute, and runs a later executable match on PATH instead (fails when the PATH search reports a non-executable match as not found, or stops at the first match)",
  { skip: POSIX_EXEC },
  async (t) => {
    const { worktree, env } = setup(t);
    const root = dirname(worktree);
    const locked = join(root, "locked");
    const open = join(root, "open");
    mkdirSync(locked);
    mkdirSync(open);
    writeFileSync(join(locked, "tool"), "#!/bin/sh\necho locked\n");
    writeFileSync(join(open, "tool"), "#!/bin/sh\necho open\n", {
      mode: 0o755,
    });
    const onPath = await lease(["run", "--", "tool"], worktree, {
      ...env,
      PATH: `${locked}:${env.PATH ?? ""}`,
    });
    assert.equal(onPath.code, 126);
    assert.match(
      onPath.stderr,
      /^antelopejs-lease: cannot run tool: \S+\/locked\/tool is not executable$/mu,
    );
    const later = await lease(["run", "--", "tool"], worktree, {
      ...env,
      PATH: `${locked}:${open}:${env.PATH ?? ""}`,
    });
    assert.deepEqual([later.code, later.stdout], [0, "open\n"]);
    const byPath = await lease(
      ["run", "--", join(locked, "tool")],
      worktree,
      env,
    );
    assert.equal(byPath.code, 126);
    const directory = await lease(["run", "--", locked], worktree, env);
    assert.equal(directory.code, 126);
    assert.match(directory.stderr, /\/locked is a directory$/mu);
  },
);

test(
  "run starts an executable text file without #! under /bin/sh as execvp does, and exits 127 naming a #! interpreter that does not exist (fails when run hands either file to execve unchecked, which makes Node abort with a native stack trace)",
  { skip: POSIX_EXEC },
  async (t) => {
    const { worktree, env } = setup(t);
    const root = dirname(worktree);
    const plain = join(root, "plain");
    const crlf = join(root, "crlf");
    writeFileSync(plain, 'echo "plain $1"\n', { mode: 0o755 });
    writeFileSync(crlf, "#!/bin/sh\r\necho crlf\n", { mode: 0o755 });
    const script = await lease(["run", "--", plain, "arg"], worktree, env);
    assert.deepEqual([script.code, script.stdout], [0, "plain arg\n"]);
    const broken = await lease(["run", "--", crlf], worktree, env);
    assert.equal(broken.code, 127);
    assert.match(
      broken.stderr,
      /^antelopejs-lease: cannot run \S+\/crlf: interpreter "\/bin\/sh\\r" not found$/mu,
    );
  },
);
