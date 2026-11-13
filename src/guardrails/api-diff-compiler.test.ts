import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  apiRepo,
  bin,
  commit,
  onTypeScript,
  put,
} from "./helpers/test-repo.ts";

/** Installs at `directory` a `typescript` that is the JavaScript entry of TypeScript 7: its `version` and no compiler API. */
function installTypeScript7(directory: string): void {
  const root = join(directory, "node_modules/typescript");
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "typescript", version: "7.0.2", main: "index.js" }),
  );
  writeFileSync(
    join(root, "index.js"),
    'module.exports = { version: "7.0.2" };\n',
  );
}

test("api-diff analyses a package on TypeScript 7, whose own typescript and the generator's have no compiler API, with the pack's TypeScript 6", (t) => {
  const root = apiRepo(t);
  onTypeScript(root, "@typescript/native");
  put(root, "src/index.ts", "export const value = 1;\n");
  commit(root);
  put(root, "src/index.ts", "export const value = 1 as const;\n");
  commit(root);
  const result = bin(root, "api-diff", ["HEAD~1"]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /^-export declare const value = 1;$/m);
  assert.doesNotMatch(result.stdout, /Execution error/);
});

test("api-diff analyses a package whose TypeScript has no compiler API, keeps analysing the rest, and lists unpublished packages", (t) => {
  const root = apiRepo(t);
  put(root, "src/index.ts", "export const value = 1;\n");
  put(
    root,
    "tools/playground/package.json",
    JSON.stringify({ name: "playground", types: "dist/index.d.ts" }),
  );
  put(
    root,
    "tools/playground/tsconfig.json",
    JSON.stringify({
      compilerOptions: { rootDir: "src", outDir: "dist", types: [] },
    }),
  );
  put(root, "tools/playground/src/index.ts", "export const seen = true;\n");
  installTypeScript7(join(root, "tools/playground"));
  put(root, "tools/private/package.json", '{"private":true}');
  put(root, "tools/private/tsconfig.json", "{}");
  put(root, "tools/bare/package.json", '{"name":"bare"}');
  put(root, "tools/bare/tsconfig.json", "{}");
  put(root, ".gitignore", "dist\n");
  commit(root);
  const result = bin(root, "api-diff", ["HEAD"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^API: 2 packages, 2 entries unchanged/m);
  assert.doesNotMatch(result.stdout, /Execution error/);
  assert.match(result.stdout, /API: skipped tools\/private, private\./);
  assert.match(
    result.stdout,
    /API: skipped tools\/bare, no exports, main or types\./,
  );
});

test("api-diff reads the config of a package on TypeScript 5 with TypeScript 5's defaults for the options TypeScript 6 changed", (t) => {
  const root = apiRepo(t);
  onTypeScript(root, "typescript5");
  put(
    root,
    "package.json",
    JSON.stringify({
      name: "legacy",
      main: "dist/index.js",
      types: "dist/index.d.ts",
      scripts: { build: "tsc" },
      devDependencies: { typescript: "^5.9.3" },
    }),
  );
  put(
    root,
    "tsconfig.json",
    JSON.stringify({
      compilerOptions: {
        target: "ES2020",
        module: "commonjs",
        baseUrl: ".",
        outDir: "dist",
        declaration: true,
      },
      include: ["src"],
    }),
  );
  put(
    root,
    "src/index.ts",
    "export function run(input) {\n  return process.cwd() + input;\n}\n",
  );
  put(root, ".gitignore", "node_modules\ndist\n");
  commit(root);
  put(
    root,
    "src/index.ts",
    "export function run(input: string) {\n  return process.cwd() + input;\n}\n",
  );
  commit(root);
  const result = bin(root, "api-diff", ["HEAD~1"]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.doesNotMatch(result.stdout, /Execution error/);
  assert.match(
    result.stdout,
    /^-export declare function run\(input: any\): string;$/m,
  );
  assert.match(
    result.stdout,
    /^\+export declare function run\(input: string\): string;$/m,
  );
});
