import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { PACKAGE_ROOT, bin, put, testRepo } from "./helpers/test-repo.ts";

const ALL_STEPS = [
  "typecheck",
  "lint",
  "format:check",
  "knip",
  "test",
  "size",
  "suppressions",
  "sync:check",
];

const RENDEZVOUS = [
  'const fs = require("node:fs");',
  "const [mine, other, outcome] = process.argv.slice(2);",
  "const pause = (ms) =>",
  "  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);",
  'fs.writeFileSync(mine, "");',
  "const deadline = Date.now() + 15000;",
  "while (!fs.existsSync(other) && Date.now() < deadline) pause(20);",
  "if (!fs.existsSync(other)) {",
  '  console.error(mine + " never saw " + other);',
  "  process.exit(1);",
  "}",
  'if (outcome === "fail-late") {',
  "  pause(500);",
  '  console.error(mine + " failed");',
  "  process.exit(1);",
  "}",
  "",
].join("\n");

function repoWith(t: TestContext, overrides: Record<string, string>) {
  const root = testRepo(t);
  put(root, "rendezvous.cjs", RENDEZVOUS);
  const scripts = {
    ...Object.fromEntries(
      ALL_STEPS.map((name) => [name, 'node -e "process.exit(0)"']),
    ),
    ...overrides,
  };
  put(
    root,
    "package.json",
    JSON.stringify({ packageManager: "npm@11.0.0", scripts }),
  );
  return root;
}

function meets(mine: string, other: string, outcome = "pass") {
  return `node rendezvous.cjs ${mine}.marker ${other}.marker ${outcome}`;
}

test("two steps that each wait for the other's marker both finish, so the steps run at the same time", (t) => {
  const root = repoWith(t, {
    typecheck: meets("typecheck", "lint"),
    lint: meets("lint", "typecheck"),
  });
  const result = bin(root, "checks", ["--no-services"]);
  assert.equal(result.status, 0, result.stdout);
  assert.equal(result.stdout, "Checks: 8 passed, 0 failed.\n");
});

test("the first and the last step run at the same time, so a bounded pool or per-pair batching is not enough", (t) => {
  const root = repoWith(t, {
    typecheck: meets("typecheck", "sync"),
    "sync:check": meets("sync", "typecheck"),
  });
  const result = bin(root, "checks", ["--no-services"]);
  assert.equal(result.status, 0, result.stdout);
  assert.equal(result.stdout, "Checks: 8 passed, 0 failed.\n");
});

test("test starts only after every other step finished, so its time limits never share the CPU with them", (t) => {
  const root = repoWith(t, {
    "sync:check":
      "node -e \"Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400); require('node:fs').writeFileSync('sync.done', '')\"",
    test: "node -e \"process.exit(require('node:fs').existsSync('sync.done') ? 0 : 1)\"",
  });
  const result = bin(root, "checks", ["--no-services"]);
  assert.equal(result.status, 0, result.stdout);
  assert.equal(result.stdout, "Checks: 8 passed, 0 failed.\n");
});

test("failures are listed in step order even when a later step fails first", (t) => {
  const root = repoWith(t, {
    lint: meets("lint", "knip", "fail-late"),
    knip: "node -e \"require('node:fs').writeFileSync('knip.marker','');console.error('knip failed');process.exit(1)\"",
  });
  const result = bin(root, "checks", ["--no-services"]);
  assert.equal(result.status, 1);
  assert.match(
    result.stdout,
    /^\[lint\]\n[\s\S]*lint\.marker failed\n\n\[knip\]\n[\s\S]*knip failed\nChecks: 6 passed, 2 failed\.\n$/,
  );
});

function lingering(name: string) {
  return `node -e "const fs=require('node:fs');fs.writeFileSync('${name}.started','');setTimeout(()=>fs.writeFileSync('${name}.finished',''),30000)"`;
}

test("an interrupt stops every running step, not only the first one started", async (t) => {
  const root = repoWith(t, {
    lint: lingering("lint"),
    knip: lingering("knip"),
  });
  const begun = Date.now();
  const status = await new Promise<number | null>((resolve) => {
    const child = spawn(
      process.execPath,
      [join(PACKAGE_ROOT, "src/bin/checks.ts"), "--no-services"],
      { cwd: root, env: { ...process.env, CI: "1" }, stdio: "ignore" },
    );
    const timer = setInterval(() => {
      if (
        !existsSync(join(root, "lint.started")) ||
        !existsSync(join(root, "knip.started"))
      )
        return;
      clearInterval(timer);
      child.kill("SIGTERM");
    }, 50);
    child.once("close", resolve);
  });
  assert.equal(status, 143);
  assert.ok(Date.now() - begun < 15000, "every step stopped before its timer");
  assert.equal(existsSync(join(root, "lint.finished")), false);
  assert.equal(existsSync(join(root, "knip.finished")), false);
});
