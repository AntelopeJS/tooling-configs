import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { bin, put } from "./helpers/test-repo.ts";

const CRASH = /panic:|goroutine \d|^\s+at .+:\d+:\d+\)?$/mu;

type CompilerOptions = Record<string, string | boolean>;

function project(
  t: TestContext,
  options: CompilerOptions,
  source: string,
): string {
  const root = mkdtempSync(join(tmpdir(), "antelope-typescript7-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  put(
    root,
    "tsconfig.json",
    JSON.stringify({ compilerOptions: { types: [], ...options } }),
  );
  put(root, "src/index.ts", source);
  return root;
}

test("antelopejs-tsc runs TypeScript 7 whatever typescript the checkout installs; an implementation that runs the project's tsc prints 6", () => {
  const result = bin(tmpdir(), "tsc", ["--version"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^Version 7\.0\./);
});

test("antelopejs-tsc passes every argument to tsc unchanged: emit flags write their files and --noEmit writes none; an implementation that drops or adds an argument fails one of the two", (t) => {
  const root = project(t, {}, "export const answer: number = 42;\n");
  const emitted = bin(root, "tsc", [
    "-p",
    ".",
    "--outDir",
    "out",
    "--declaration",
    "--rootDir",
    "src",
  ]);
  assert.equal(emitted.status, 0, emitted.stdout + emitted.stderr);
  assert.ok(existsSync(join(root, "out/index.js")));
  assert.ok(existsSync(join(root, "out/index.d.ts")));
  const checked = bin(root, "tsc", ["-p", ".", "--noEmit", "--outDir", "dry"]);
  assert.equal(checked.status, 0, checked.stdout + checked.stderr);
  assert.ok(!existsSync(join(root, "dry")));
});

test("antelopejs-tsc exits non-zero with tsc's diagnostic on a type error; an implementation that drops the compiler's exit status exits 0", (t) => {
  const root = project(
    t,
    { noEmit: true },
    "export const answer: string = 42;\n",
  );
  const result = bin(root, "tsc", ["-p", ".", "--pretty", "false"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /src\/index\.ts\(1,14\): error TS2322/);
});

test("antelopejs-tsc names each tsconfig option TypeScript 7 removed and exits non-zero without a crash, set directly or through extends; a compiler that panics or exits 0 on it fails", (t) => {
  const removed: [CompilerOptions, RegExp][] = [
    [{ baseUrl: "." }, /Option 'baseUrl' has been removed/],
    [
      { module: "commonjs", moduleResolution: "node" },
      /Option 'moduleResolution=node10' has been removed/,
    ],
    [{ target: "es5" }, /Option 'target=ES5' has been removed/],
    [
      { downlevelIteration: true },
      /Option 'downlevelIteration' has been removed/,
    ],
    [
      { esModuleInterop: false },
      /Option 'esModuleInterop=false' has been removed/,
    ],
    [{ alwaysStrict: false }, /Option 'alwaysStrict=false' has been removed/],
  ];
  for (const [options, message] of removed) {
    const root = project(t, { noEmit: true, ...options }, "export {};\n");
    put(
      root,
      "tsconfig.extends.json",
      JSON.stringify({ extends: "./tsconfig.json", include: ["src"] }),
    );
    for (const config of ["tsconfig.json", "tsconfig.extends.json"]) {
      const result = bin(root, "tsc", ["-p", config]);
      const output = result.stdout + result.stderr;
      assert.notEqual(result.status, 0, `${config} ${output}`);
      assert.match(output, message, config);
      assert.doesNotMatch(output, CRASH, config);
    }
  }
});
