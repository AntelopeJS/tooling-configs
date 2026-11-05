import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
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
import { parseJson, type JsonValue } from "../garden/json.ts";

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

test("a SIGTERM to run's whole process group reaches the command once (fails when run forwards a signal its command also got from the group kill)", async (t) => {
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
});

test("a SIGTERM to the pid of run reaches the command once (fails when run neither forwards nor becomes the command, so a direct kill never reaches it)", async (t) => {
  const { worktree, env, argv } = setup(t);
  const [file = "", ...args] = argv;
  const direct = startCaptured(file, args, { cwd: worktree, env });
  t.after(() => direct.child.kill("SIGKILL"));
  assert.equal(await firstLine(direct), "ready");
  direct.child.kill("SIGTERM");
  assert.deepEqual(counts(await direct.done), { SIGTERM: 1 });
});

test("run exits with its command's code, 128 plus the signal for a killed command, and 127 for a missing one (fails when run reports its own status instead of the command's)", async (t) => {
  const { worktree, env } = setup(t);
  assert.equal(
    (await lease(["run", "--", "sh", "-c", "exit 7"], worktree, env)).code,
    7,
  );
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
