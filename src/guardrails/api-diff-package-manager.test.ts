import assert from "node:assert/strict";
import { symlinkSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  bin,
  commit,
  PACKAGE_ROOT,
  put,
  testRepo,
} from "./helpers/test-repo.ts";

test("api-diff builds a workspace package with the package manager its workspace root declares", (t) => {
  const root = testRepo(t);
  put(
    root,
    "packages/lib/package.json",
    JSON.stringify({
      name: "lib",
      type: "module",
      scripts: { build: "node manager.cjs && tsc" },
      types: "./dist/index.d.ts",
      exports: { ".": "./dist/index.js" },
    }),
  );
  put(
    root,
    "packages/lib/manager.cjs",
    'const runner = require("node:path").basename(process.env.npm_execpath ?? "");\nif (runner !== "npm-cli.js") { console.error(`built by ${runner}`); process.exit(1); }\n',
  );
  put(
    root,
    "packages/lib/tsconfig.json",
    JSON.stringify({
      compilerOptions: {
        rootDir: "src",
        outDir: "dist",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        declaration: true,
        types: [],
      },
      include: ["src/**/*"],
    }),
  );
  symlinkSync(
    join(PACKAGE_ROOT, "node_modules"),
    join(root, "packages/lib/node_modules"),
    "dir",
  );
  put(root, "packages/lib/src/index.ts", "export const answer = 42;\n");
  commit(root);
  const result = bin(root, "api-diff", ["HEAD"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Runtime API: 1 packages, 1 entries unchanged/);
});
