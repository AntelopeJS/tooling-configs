import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { fakeTools } from "./helpers/fake-tools.ts";
import { bareJsRepo, bareRepo, workingTree } from "./helpers/init-repo.ts";
import { bin, put, read } from "./helpers/test-repo.ts";
import { parseManifest, toolingVersions } from "./package.ts";

function manifest(root: string) {
  return parseManifest(read(root, "package.json"));
}

test("--init pins the pack's pnpm in a repository without packageManager and keeps an existing pin, where an init that leaves it unset fails pnpm/action-setup in ci / checks", (t) => {
  const unpinned = bareJsRepo(t);
  assert.equal(bin(unpinned, "sync", ["--init"], fakeTools(t).env).status, 0);
  const pin = manifest(unpinned).packageManager;
  assert.match(pin ?? "", /^pnpm@\d+\.\d+\.\d+$/);
  assert.equal(pin, toolingVersions().packageManager);
  const pinned = bareRepo(t);
  assert.equal(bin(pinned, "sync", ["--init"], fakeTools(t).env).status, 0);
  assert.equal(manifest(pinned).packageManager, "pnpm@10.20.0");
});

test("--init imports npm's lockfile into pnpm before the first install and deletes it, where an init that keeps it leaves two lockfiles and one that skips the import drops npm's resolved versions", (t) => {
  const root = bareJsRepo(t);
  const tools = fakeTools(t);
  const result = bin(root, "sync", ["--init"], tools.env);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const calls = tools.calls().filter((call) => call.startsWith("pnpm"));
  assert.equal(calls[0], "pnpm import");
  assert.match(calls[1] ?? "", /^pnpm install/);
  assert.equal(existsSync(join(root, "package-lock.json")), false);
  assert.match(result.stdout, /^Removed: package-lock\.json$/m);
});

test("--init deletes npm's lockfile without importing it when pnpm's already exists, where an init that imports again overwrites the pnpm lockfile", (t) => {
  const root = bareJsRepo(t);
  const tools = fakeTools(t);
  put(root, "pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
  assert.equal(bin(root, "sync", ["--init"], tools.env).status, 0);
  assert.equal(tools.calls().includes("pnpm import"), false);
  assert.equal(existsSync(join(root, "package-lock.json")), false);
  assert.equal(read(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
});

/** The diagnostics a tool printed for the repository's JavaScript, leaving out the synced `*.config.ts` files, which import the fake pack that ships no type declarations. */
function javaScriptDiagnostics(output: string): string[] {
  return output.split("\n").filter((line) => /^\S+\.js[(:]/.test(line));
}

function nodeTool(root: string, bin: string, args: string[]) {
  return spawnSync(
    process.execPath,
    [join(root, "node_modules", bin), ...args],
    {
      cwd: root,
      encoding: "utf8",
    },
  );
}

test("--init declares typescript and @types/node and writes a tsconfig under which the repository's untyped JavaScript passes and a type error fails, where an init that only adds `tsc --noEmit` fails with tsc not found and one that turns on strict fails every untyped parameter", (t) => {
  const root = bareJsRepo(t);
  assert.equal(bin(root, "sync", ["--init"], fakeTools(t).env).status, 0);
  assert.equal(manifest(root).scripts?.typecheck, "tsc --noEmit");
  const tsc = () => nodeTool(root, "typescript/bin/tsc", ["--noEmit"]);
  assert.deepEqual(javaScriptDiagnostics(tsc().stdout), []);
  put(root, "broken.js", "const count = 1;\ncount.toUpperCase();\n");
  assert.match(tsc().stdout, /broken\.js.*TS2339/);
});

test("--init leaves a repository whose source oxfmt lengthens passing lint, where an init that formats after sync measured the baseline records no ceiling for the longer file", (t) => {
  const root = bareJsRepo(t);
  const statements = Array.from(
    { length: 260 },
    (_, index) => `let a${index} = ${index}; let b${index} = a${index};`,
  );
  put(root, "big.js", `${statements.join("\n")}\n`);
  assert.equal(bin(root, "sync", ["--init"], fakeTools(t).env).status, 0);
  assert.ok(read(root, "big.js").split("\n").length > 500);
  const lint = nodeTool(root, "oxlint/bin/oxlint", []);
  assert.deepEqual(javaScriptDiagnostics(lint.stdout), []);
});

test("a second --init on a bare JavaScript repository changes no file, where an init that rewrites the tsconfig, the test script or the formatted source every run never settles", (t) => {
  const root = bareJsRepo(t);
  const tools = fakeTools(t);
  assert.equal(bin(root, "sync", ["--init"], tools.env).status, 0);
  const first = workingTree(root);
  const second = bin(root, "sync", ["--init"], tools.env);
  assert.equal(second.status, 0, second.stderr + second.stdout);
  assert.deepEqual(workingTree(root), first);
  assert.equal(
    tools.calls().filter((call) => call === "pnpm import").length,
    1,
  );
});

test("--init keeps a repository's own tsconfig and adds no @types/node to it, where an init that writes its tsconfig over the repository's loses its compiler options", (t) => {
  const root = bareJsRepo(t);
  const tools = fakeTools(t);
  const own = '{\n  "compilerOptions": {\n    "strict": true\n  }\n}\n';
  put(root, "tsconfig.json", own);
  assert.equal(bin(root, "sync", ["--init"], tools.env).status, 0);
  assert.equal(read(root, "tsconfig.json"), own);
  const installed = tools.installs().at(-1) ?? [];
  assert.ok(installed.includes("typescript"), installed.join(" "));
  assert.equal(installed.includes("@types/node"), false);
});

test("--init replaces npm's failing default test script with one that passes beside its test-job, and gives one to a repository without any, where an init that keeps either fails `pnpm run test`", (t) => {
  const npmDefault = bareJsRepo(t);
  const missing = bareJsRepo(t);
  put(missing, "package.json", '{\n  "name": "probe",\n  "private": true\n}\n');
  for (const root of [npmDefault, missing]) {
    assert.equal(bin(root, "sync", ["--init"], fakeTools(t).env).status, 0);
    assert.match(
      read(root, ".github/workflows/ci.yml"),
      /^ {6}test-job: true$/m,
    );
    const script = manifest(root).scripts?.test;
    assert.ok(script, "package.json has no test script for the test job");
    const run = spawnSync("sh", ["-c", script], {
      cwd: root,
      encoding: "utf8",
    });
    assert.equal(run.status, 0, `${script}\n${run.stdout}${run.stderr}`);
  }
});

test("--init formats the repository's own source and names it, where an init that formats only package.json leaves format:check red on server.js", (t) => {
  const root = bareJsRepo(t);
  const result = bin(root, "sync", ["--init"], fakeTools(t).env);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /^Updated: server\.js$/m);
  const check = spawnSync(
    process.execPath,
    [join(root, "node_modules/oxfmt/bin/oxfmt"), "--check", "."],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(check.status, 0, check.stdout + check.stderr);
});
