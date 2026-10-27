import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";

import { apiRepo, bin, commit, put } from "./helpers/test-repo.ts";

const TYPESCRIPT = dirname(
  createRequire(import.meta.url).resolve("typescript/package.json"),
);

function installTypeScript(
  directory: string,
  source: string,
  version: string,
): void {
  const root = join(directory, "node_modules/typescript");
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "typescript", version, main: "index.js" }),
  );
  writeFileSync(join(root, "index.js"), source);
}

const RECORDING_TYPESCRIPT = `
const real = require(${JSON.stringify(join(TYPESCRIPT, "lib/typescript.js"))});
module.exports = {
  ...real,
  createProgram(...args) {
    const origin = new Error().stack.includes("dts-bundle-generator") ? "generator" : "emit";
    process.stderr.write("program from " + origin + "\\n");
    return real.createProgram(...args);
  },
};
`;

test("api-diff bundles declarations with the TypeScript the target package builds with, not the one the generator was installed with", (t) => {
  const root = apiRepo(t);
  rmSync(join(root, "node_modules"));
  installTypeScript(root, RECORDING_TYPESCRIPT, "5.9.3");
  put(
    root,
    "package.json",
    JSON.stringify({
      name: "public-api",
      type: "module",
      scripts: {
        build: `node ${JSON.stringify(join(TYPESCRIPT, "bin/tsc"))} --noEmit false --composite false --declarationMap false`,
      },
      exports: {
        ".": { types: "./dist/index.d.ts", default: "./dist/index.js" },
      },
    }),
  );
  put(root, "src/index.ts", "export const value = 1;\n");
  commit(root);
  const result = bin(root, "api-diff", ["HEAD"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /^program from generator$/m);
});

test("api-diff names a package whose TypeScript has no compiler API instead of crashing, keeps analysing the rest, and lists unpublished packages", (t) => {
  const root = apiRepo(t);
  put(root, "src/index.ts", "export const value = 1;\n");
  put(
    root,
    "tools/playground/package.json",
    JSON.stringify({ name: "playground", main: "dist/index.js" }),
  );
  put(root, "tools/playground/tsconfig.json", "{}");
  installTypeScript(
    join(root, "tools/playground"),
    'module.exports = { version: "7.0.2" };\n',
    "7.0.2",
  );
  put(root, "tools/private/package.json", '{"private":true}');
  put(root, "tools/private/tsconfig.json", "{}");
  put(root, "tools/bare/package.json", '{"name":"bare"}');
  put(root, "tools/bare/tsconfig.json", "{}");
  put(root, ".gitignore", "dist\n");
  commit(root);
  const result = bin(root, "api-diff", ["HEAD"]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(
    result.stdout,
    /Execution error: tools\/playground \(playground\): TypeScript 7\.0\.2 .* no programmatic compiler API/,
  );
  assert.match(result.stdout, /API: skipped tools\/private, private\./);
  assert.match(
    result.stdout,
    /API: skipped tools\/bare, no exports, main or types\./,
  );
  assert.doesNotMatch(result.stdout + result.stderr, /\n\s+at .*\(/);
  assert.match(result.stdout, /Runtime API: .*entries unchanged/);
});
