import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import type { JsonObject } from "../garden/json.ts";
import { missingBuildOutput } from "./built.ts";

function repo(
  t: test.TestContext,
  manifests: Record<string, JsonObject>,
  built: string[],
): string {
  const root = mkdtempSync(join(tmpdir(), "capture-built-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [dir, manifest] of Object.entries(manifests)) {
    mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(join(root, dir, "package.json"), JSON.stringify(manifest));
  }
  for (const file of built) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), "");
  }
  return root;
}

test("missingBuildOutput names each declared entry file that is not on disk, in every published package", (t) => {
  const root = repo(
    t,
    {
      ".": { name: "root-workspace", private: true, main: "dist/root.js" },
      "packages/dms": {
        name: "@antelopejs/dms",
        types: "dist/index.d.ts",
        exports: {
          ".": { import: "./dist/index.js", types: "./dist/index.d.ts" },
          "./components/*": "./dist/components/*.js",
        },
      },
      "packages/cli": {
        name: "@antelopejs/cli",
        main: "dist/cli.js",
        bin: { cli: "./dist/cli.js" },
      },
    },
    ["packages/dms/dist/index.d.ts"],
  );
  assert.deepEqual(missingBuildOutput(root), [
    "@antelopejs/cli: packages/cli/dist/cli.js is missing",
    "@antelopejs/dms: packages/dms/dist/index.js is missing",
  ]);
});

test("a built module has no missing build output", (t) => {
  const root = repo(
    t,
    {
      ".": {
        name: "@antelopejs/mollie",
        main: "dist/index.js",
        exports: { ".": "./dist/index.js" },
      },
    },
    ["dist/index.js"],
  );
  assert.deepEqual(missingBuildOutput(root), []);
});
