import assert from "node:assert/strict";
import { mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { DIRECTORY_LINK } from "./revisions.ts";
import { apiRepo, bin, commit, put } from "./helpers/test-repo.ts";

function linkPlayground(root: string): void {
  put(
    root,
    "playground/package.json",
    JSON.stringify({
      name: "playground",
      private: true,
      dependencies: { "public-api": "link:.." },
    }),
  );
  mkdirSync(join(root, "playground/node_modules"), { recursive: true });
  symlinkSync(
    "../..",
    join(root, "playground/node_modules/public-api"),
    DIRECTORY_LINK,
  );
}

function compile(root: string, exports: Record<string, string>): void {
  put(
    root,
    "package.json",
    JSON.stringify({
      name: "public-api",
      type: "module",
      scripts: {
        build: "tsc --noEmit false --composite false --declarationMap false",
      },
      exports,
    }),
  );
  put(
    root,
    "tsconfig.json",
    JSON.stringify({
      compilerOptions: {
        target: "ES2020",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        rootDir: "src",
        outDir: "dist",
        types: [],
        strict: true,
        noEmit: true,
        declaration: true,
      },
      include: ["src/**/*"],
    }),
  );
}

test("api-diff compares a directory wildcard export when a playground links back to the package", (t) => {
  const root = apiRepo(t);
  compile(root, {
    ".": "./dist/index.js",
    "./dist/*": "./dist/*/index.js",
  });
  put(root, "src/index.ts", "export const value = 1;\n");
  put(root, "src/feature/index.ts", "export const feature = 1;\n");
  linkPlayground(root);
  commit(root);
  const result = bin(root, "api-diff", ["HEAD"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Runtime API: 1 packages, 2 entries unchanged/);
});

test("api-diff still compares a wildcard entry reached through a directory link inside the package, past a link to itself", (t) => {
  const root = apiRepo(t);
  compile(root, {
    ".": "./dist/index.js",
    "./compat/*": "./compat/*/index.js",
  });
  put(root, "src/index.ts", "export const value = 1;\n");
  put(root, "legacy/index.js", "export const a = 1;\nexport const b = 2;\n");
  put(root, "compat/v1/index.js", "export const v1 = 1;\n");
  symlinkSync("../legacy", join(root, "compat/v2"), DIRECTORY_LINK);
  symlinkSync("loop", join(root, "compat/loop"));
  linkPlayground(root);
  commit(root);
  put(root, "legacy/index.js", "export const a = 1;\n");
  commit(root);
  const result = bin(root, "api-diff", ["HEAD~1"]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /Runtime API: differences/);
  assert.match(result.stdout, /compat%2Fv2/);
});
