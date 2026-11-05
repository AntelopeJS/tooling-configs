import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test, { type TestContext } from "node:test";

import { publishedPorts } from "./services.ts";
import { claimPort, closeServer } from "../lease/ports.ts";
import { PACKAGE_ROOT, bin, put, read, testRepo } from "./helpers/test-repo.ts";

const STEPS = [
  "typecheck",
  "lint",
  "format:check",
  "knip",
  "test",
  "size",
  "suppressions",
  "sync:check",
];

const UNREACHABLE_COMPOSE =
  'services:\n  mongo:\n    image: mongo:8\n    ports:\n      - "1:27017"\n';

function logLines(root: string): string[] {
  return existsSync(join(root, "calls.log"))
    ? read(root, "calls.log").trim().split("\n").filter(Boolean)
    : [];
}

function fakeDockerPath(t: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), "antelope-docker-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  put(
    directory,
    "docker",
    [
      "#!/bin/sh",
      'echo "docker $*" >> "$CALLS_LOG"',
      'case "$*" in *" up "*) exit "${FAKE_UP_EXIT:-0}";; esac',
      "",
    ].join("\n"),
  );
  chmodSync(join(directory, "docker"), 0o755);
  return directory;
}

function servicesRepo(
  t: TestContext,
  compose: string | undefined,
  testScript = "node -e \"require('node:fs').appendFileSync('calls.log', 'step test\\n')\"",
) {
  const root = testRepo(t);
  if (compose !== undefined) put(root, ".github/compose.yml", compose);
  const scripts = Object.fromEntries(
    STEPS.map((name) => [name, 'node -e "process.exit(0)"']),
  );
  scripts.test = testScript;
  put(
    root,
    "package.json",
    JSON.stringify({ packageManager: "npm@11.0.0", scripts }),
  );
  return root;
}

function dockerEnv(t: TestContext, root: string, extra = {}) {
  return {
    PATH: `${fakeDockerPath(t)}${delimiter}${process.env.PATH ?? ""}`,
    CALLS_LOG: join(root, "calls.log"),
    ...extra,
  };
}

test("checks start the compose services before the steps and remove them after", (t) => {
  const root = servicesRepo(t, UNREACHABLE_COMPOSE);
  const result = bin(root, "checks", [], dockerEnv(t, root));
  assert.equal(result.status, 0, result.stdout);
  assert.equal(result.stdout, "Checks: 8 passed, 0 failed.\n");
  assert.deepEqual(logLines(root), [
    "docker compose -f .github/compose.yml version",
    "docker compose -f .github/compose.yml up -d --wait",
    "step test",
    "docker compose -f .github/compose.yml down -v",
  ]);
});

test("checks remove the compose services when a step fails", (t) => {
  const root = servicesRepo(
    t,
    UNREACHABLE_COMPOSE,
    "node -e \"console.error('tests broke');process.exit(1)\"",
  );
  const result = bin(root, "checks", [], dockerEnv(t, root));
  assert.equal(result.status, 1);
  assert.match(result.stdout, /tests broke/);
  assert.match(result.stdout, /Checks: 7 passed, 1 failed\./);
  assert.equal(
    logLines(root).at(-1),
    "docker compose -f .github/compose.yml down -v",
  );
});

test("checks run no step when the services fail to start, and still remove what started", (t) => {
  const root = servicesRepo(t, UNREACHABLE_COMPOSE);
  const result = bin(
    root,
    "checks",
    [],
    dockerEnv(t, root, { FAKE_UP_EXIT: "1" }),
  );
  assert.equal(result.status, 1);
  assert.match(
    result.stdout,
    /^\[services\]\ndocker compose -f \.github\/compose\.yml up -d --wait: exited with status 1\n/,
  );
  assert.match(result.stdout, /Checks: 0 passed, 1 failed\./);
  assert.ok(!logLines(root).includes("step test"));
  assert.equal(
    logLines(root).at(-1),
    "docker compose -f .github/compose.yml down -v",
  );
});

test("--no-services runs the steps without calling Docker", (t) => {
  const root = servicesRepo(t, UNREACHABLE_COMPOSE);
  const result = bin(root, "checks", ["--no-services"], dockerEnv(t, root));
  assert.equal(result.status, 0, result.stdout);
  assert.deepEqual(logLines(root), ["step test"]);
});

test("checks without a compose file never call Docker", (t) => {
  const root = servicesRepo(t, undefined);
  const result = bin(root, "checks", [], dockerEnv(t, root));
  assert.equal(result.status, 0, result.stdout);
  assert.deepEqual(logLines(root), ["step test"]);
});

test("checks fail at once, naming the compose file, when Docker is missing", (t) => {
  const root = servicesRepo(t, UNREACHABLE_COMPOSE);
  const gitOnly = mkdtempSync(join(tmpdir(), "antelope-no-docker-"));
  t.after(() => rmSync(gitOnly, { recursive: true, force: true }));
  symlinkSync(
    execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim(),
    join(gitOnly, "git"),
  );
  const result = bin(root, "checks", [], { PATH: gitOnly });
  assert.equal(result.status, 1);
  assert.match(
    result.stdout,
    /Docker Compose is not available, so the services in \.github\/compose\.yml cannot start/,
  );
  assert.match(result.stdout, /--no-services/);
  assert.match(result.stdout, /Checks: 0 passed, 1 failed\./);
  assert.deepEqual(logLines(root), []);
});

test("checks leave services alone when every published port already answers", async (t) => {
  let port = 47017;
  let server = await claimPort(port, "127.0.0.1");
  while (server === undefined) {
    port += 1;
    server = await claimPort(port, "127.0.0.1");
  }
  const listening = server;
  t.after(() => closeServer(listening));
  const root = servicesRepo(
    t,
    `services:\n  mongo:\n    image: mongo:8\n    ports:\n      - "${port}:27017"\n`,
  );
  const result = await runBin(root, [], dockerEnv(t, root));
  assert.equal(result.status, 0, result.stdout);
  assert.deepEqual(logLines(root), ["step test"]);
});

test("an interrupted run stops the running step and removes the services", async (t) => {
  const root = servicesRepo(
    t,
    UNREACHABLE_COMPOSE,
    "node -e \"require('node:fs').appendFileSync('calls.log', 'step test\\n');setTimeout(() => require('node:fs').appendFileSync('calls.log', 'step finished\\n'), 30000)\"",
  );
  const result = await runBin(root, [], dockerEnv(t, root), (child) => {
    const timer = setInterval(() => {
      if (!logLines(root).includes("step test")) return;
      clearInterval(timer);
      child.kill("SIGTERM");
    }, 50);
  });
  assert.equal(result.status, 143, result.stdout);
  assert.match(result.stdout, /Checks interrupted by SIGTERM\./);
  const lines = logLines(root);
  assert.ok(!lines.includes("step finished"));
  assert.equal(lines.at(-1), "docker compose -f .github/compose.yml down -v");
});

test("publishedPorts reads the short and long port syntax and gives up on what it cannot probe", () => {
  assert.deepEqual(
    publishedPorts(
      'services:\n  a:\n    ports:\n      - "127.0.0.1:27017:27017"\n      - "6379:6379/tcp"\n  b:\n    ports:\n      - target: 80\n        published: 8080\n',
    ),
    [27017, 6379, 8080],
  );
  assert.equal(
    publishedPorts('services:\n  a:\n    ports:\n      - "27017"\n'),
    undefined,
  );
  assert.equal(publishedPorts("services:\n  a:\n    image: x\n"), undefined);
  assert.equal(
    publishedPorts('services:\n  a:\n    ports:\n      - "${PORT}:80"\n'),
    undefined,
  );
});

function runBin(
  root: string,
  args: string[],
  env: Record<string, string>,
  onSpawn?: (child: ReturnType<typeof spawn>) => void,
): Promise<{ status: number | null; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [join(PACKAGE_ROOT, "src/bin/checks.ts"), ...args],
      { cwd: root, env: { ...process.env, CI: "1", ...env } },
    );
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    onSpawn?.(child);
    child.once("close", (status) => resolve({ status, stdout }));
  });
}
