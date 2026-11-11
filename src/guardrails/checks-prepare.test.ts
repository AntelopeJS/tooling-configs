import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { PACKAGE_ROOT, bin, put, read, testRepo } from "./helpers/test-repo.ts";

const PASS = 'node -e "process.exit(0)"';

const BUILD = [
  'const fs = require("node:fs");',
  'fs.appendFileSync("../../builds.log", "build\\n");',
  "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);",
  'fs.mkdirSync("dist", { recursive: true });',
  'fs.writeFileSync("dist/index.js", "");',
  "",
].join("\n");

const READS_DIST = [
  'const fs = require("node:fs");',
  'if (fs.existsSync("packages/interface/dist/index.js")) process.exit(0);',
  'console.error("packages/interface/dist/index.js is not built");',
  "process.exit(1);",
  "",
].join("\n");

const BUILD_INTERFACE = "npm --workspace packages/interface run build";

function workspace(t: TestContext, scripts: Record<string, string>) {
  const root = testRepo(t);
  put(
    root,
    "packages/interface/package.json",
    JSON.stringify({ name: "interface", scripts: { build: "node build.cjs" } }),
  );
  put(root, "packages/interface/build.cjs", BUILD);
  put(root, "reads-dist.cjs", READS_DIST);
  put(
    root,
    "package.json",
    JSON.stringify({
      packageManager: "npm@11.0.0",
      workspaces: ["packages/*"],
      scripts: {
        typecheck: `${BUILD_INTERFACE} && node reads-dist.cjs`,
        lint: "node reads-dist.cjs",
        "format:check": PASS,
        knip: PASS,
        test: PASS,
        size: PASS,
        suppressions: PASS,
        "sync:check": PASS,
        ...scripts,
      },
    }),
  );
  return root;
}

function builds(root: string): number {
  return existsSync(join(root, "builds.log"))
    ? read(root, "builds.log").split("\n").length - 1
    : 0;
}

test("without checks:prepare, a typecheck that builds a workspace package runs before lint, so lint reads the built dist", (t) => {
  const root = workspace(t, {});
  const result = bin(root, "checks", ["--no-services"]);
  assert.equal(result.status, 0, result.stdout);
  assert.equal(result.stdout, "Checks: 9 passed, 0 failed.\n");
  assert.equal(builds(root), 1);
});

test("checks:prepare builds the dist once before the steps start, so lint beside typecheck passes", (t) => {
  const root = workspace(t, { "checks:prepare": BUILD_INTERFACE });
  const result = bin(root, "checks", ["--no-services"]);
  assert.equal(result.status, 0, result.stdout);
  assert.equal(result.stdout, "Checks: 9 passed, 0 failed.\n");
  assert.equal(builds(root), 2, "checks:prepare once, typecheck's own once");
});

test("a failing checks:prepare reports its output and runs no step", (t) => {
  const root = workspace(t, {
    "checks:prepare":
      "node -e \"console.error('prepare broke');process.exit(1)\"",
    typecheck:
      "node -e \"require('node:fs').writeFileSync('typecheck.ran','')\"",
  });
  const result = bin(root, "checks", ["--no-services"]);
  assert.equal(result.status, 1);
  assert.match(
    result.stdout,
    /^\[checks:prepare\]\n[\s\S]*prepare broke\nChecks: 0 passed, 1 failed\.\n$/,
  );
  assert.equal(existsSync(join(root, "typecheck.ran")), false);
});

test("an interrupt during checks:prepare stops it, starts no step and reports the interrupt", async (t) => {
  const root = workspace(t, {
    "checks:prepare":
      "node -e \"require('node:fs').writeFileSync('prepare.started','');setTimeout(()=>{},30000)\"",
    typecheck:
      "node -e \"require('node:fs').writeFileSync('typecheck.ran','')\"",
  });
  const { status, stdout } = await new Promise<{
    status: number | null;
    stdout: string;
  }>((resolve) => {
    const child = spawn(
      process.execPath,
      [join(PACKAGE_ROOT, "src/bin/checks.ts"), "--no-services"],
      { cwd: root, env: { ...process.env, CI: "1" } },
    );
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
    const deadline = Date.now() + 10000;
    const timer = setInterval(() => {
      if (!existsSync(join(root, "prepare.started")) && Date.now() < deadline)
        return;
      clearInterval(timer);
      child.kill("SIGTERM");
    }, 50);
    child.once("close", (code) => resolve({ status: code, stdout: out }));
  });
  assert.equal(status, 143);
  assert.match(
    stdout,
    /^\[checks:prepare\]\n[\s\S]*Terminated by SIGTERM\nChecks interrupted by SIGTERM\.\n$/,
  );
  assert.equal(existsSync(join(root, "typecheck.ran")), false);
});

test("checks:prepare does not run when every step is skipped", (t) => {
  const root = workspace(t, { "checks:prepare": BUILD_INTERFACE });
  const result = bin(root, "checks", ["--no-services"], {
    ANTELOPEJS_CHECKS_SKIP:
      "typecheck,lint,format:check,knip,test,size,suppressions,sync:check,git:identity",
  });
  assert.equal(result.status, 0, result.stdout);
  assert.equal(result.stdout, "Checks: 0 passed, 0 failed, 9 skipped.\n");
  assert.equal(builds(root), 0);
});
