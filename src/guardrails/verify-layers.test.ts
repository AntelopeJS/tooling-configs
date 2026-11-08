import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";

import { typecheckLayers } from "./verify-layers.ts";

const LAYER = ".agents/skills/verify-interface";
const NOT_INSTALLED = "TypeScript is not installed in the repository root";
const FAKE_TSC = 'process.stdout.write("fake tsc ran\\n"); process.exit(1);\n';

const TYPESCRIPT_5 = JSON.stringify({
  name: "typescript",
  version: "5.9.3",
  main: "./lib/typescript.js",
  bin: { tsc: "./bin/tsc" },
});
const TYPESCRIPT_7_EXPORTS = {
  ".": "./lib/typescript.js",
  "./package.json": "./package.json",
  "./unstable/*": "./unstable/*.js",
};
const TYPESCRIPT_7 = JSON.stringify({
  name: "typescript",
  version: "7.0.2",
  bin: { tsc: "./bin/tsc" },
  exports: TYPESCRIPT_7_EXPORTS,
});
const TYPESCRIPT_7_WITHOUT_BIN = JSON.stringify({
  name: "typescript",
  version: "7.0.2",
  exports: TYPESCRIPT_7_EXPORTS,
});

function put(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

/** A repository with one verify layer whose own TypeScript has the `package.json` text `manifest`, or none. */
function repository(t: TestContext, manifest?: string): string {
  const root = mkdtempSync(join(tmpdir(), "antelope-verify-layers-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  put(root, "package.json", '{ "name": "consumer", "type": "module" }');
  put(
    root,
    `${LAYER}/tsconfig.json`,
    JSON.stringify({
      compilerOptions: { types: [] },
      files: ["verify.config.ts"],
    }),
  );
  put(root, `${LAYER}/verify.config.ts`, "export default {};\n");
  if (manifest !== undefined) {
    put(root, "node_modules/typescript/package.json", manifest);
    put(root, "node_modules/typescript/bin/tsc", FAKE_TSC);
  }
  return root;
}

test("typecheckLayers runs the compiler of a TypeScript without an exports map", async (t) => {
  const output = await typecheckLayers(repository(t, TYPESCRIPT_5));
  assert.equal(output, "fake tsc ran\n");
});

test("typecheckLayers runs the compiler of a TypeScript whose exports map leaves out bin/tsc", async (t) => {
  const output = await typecheckLayers(repository(t, TYPESCRIPT_7));
  assert.equal(output, "fake tsc ran\n");
});

test("typecheckLayers reports a repository without TypeScript as not installed", async (t) => {
  const output = await typecheckLayers(repository(t));
  assert.match(output, new RegExp(NOT_INSTALLED));
});

test("typecheckLayers reports a TypeScript package without bin.tsc as not installed", async (t) => {
  const output = await typecheckLayers(repository(t, TYPESCRIPT_7_WITHOUT_BIN));
  assert.match(output, new RegExp(NOT_INSTALLED));
});
