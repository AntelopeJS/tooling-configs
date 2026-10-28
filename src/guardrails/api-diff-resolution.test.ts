import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { apiRepo, bin, commit, put } from "./helpers/test-repo.ts";

interface Declared {
  private?: boolean;
  devDependencies?: Record<"typescript", string>;
  workspaces?: string[];
}

function prebuiltPackage(root: string, manifest: Declared = {}): void {
  rmSync(join(root, "node_modules"));
  put(
    root,
    "package.json",
    JSON.stringify({
      name: "public-api",
      type: "module",
      exports: {
        ".": { types: "./dist/index.d.ts", default: "./dist/index.js" },
      },
      ...manifest,
    }),
  );
  put(root, "src/index.ts", "export const value = 1;\n");
  put(root, "dist/index.js", "export const value = 1;\n");
  commit(root);
}

test("api-diff fails a package that declares typescript when it does not resolve, naming the package and the install", (t) => {
  const root = apiRepo(t);
  prebuiltPackage(root, { devDependencies: { typescript: "^5.9.3" } });
  const result = bin(root, "api-diff", ["HEAD"]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(
    result.stdout,
    /Execution error: \. \(public-api\): public-api \(\.\) declares typescript .*pnpm install/,
  );
});

test("api-diff fails a workspace package whose root declares typescript when it does not resolve", (t) => {
  const root = apiRepo(t);
  prebuiltPackage(root, {
    private: true,
    devDependencies: { typescript: "^5.9.3" },
    workspaces: ["packages/*"],
  });
  put(
    root,
    "packages/lib/package.json",
    JSON.stringify({ name: "lib", main: "dist/index.js" }),
  );
  put(root, "packages/lib/tsconfig.json", "{}");
  put(root, "packages/lib/src/index.ts", "export const value = 1;\n");
  put(root, "packages/lib/dist/index.js", "exports.value = 1;\n");
  commit(root);
  const result = bin(root, "api-diff", ["HEAD"]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(
    result.stdout,
    /Execution error: packages\/lib \(lib\): lib \(packages\/lib\) declares typescript .*pnpm install/,
  );
});

test("api-diff falls back to the pack's TypeScript for a package that declares none and says so once", (t) => {
  const root = apiRepo(t);
  prebuiltPackage(root);
  const result = bin(root, "api-diff", ["HEAD"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(
    result.stdout.match(
      /^\.: declares no typescript; using the pack's TypeScript \d+\.\d+\.\d+$/gm,
    )?.length,
    1,
    result.stdout,
  );
});

test("api-diff prints no fallback notice for a package that resolves its own typescript", (t) => {
  const root = apiRepo(t);
  put(root, "src/index.ts", "export const value = 1;\n");
  commit(root);
  const result = bin(root, "api-diff", ["HEAD"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.doesNotMatch(result.stdout, /declares no typescript/);
});
