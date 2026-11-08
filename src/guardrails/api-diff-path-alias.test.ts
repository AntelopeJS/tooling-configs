import assert from "node:assert/strict";
import test from "node:test";

import {
  API_BUILD_SCRIPT,
  apiRepo,
  bin,
  commit,
  put,
} from "./helpers/test-repo.ts";

test("api-diff follows a `@/` path alias in declarations and at runtime, so a change behind it shows in both halves", (t) => {
  const root = apiRepo(t);
  put(
    root,
    "package.json",
    JSON.stringify({
      name: "aliased",
      main: "dist/index.js",
      types: "dist/index.d.ts",
      scripts: { build: API_BUILD_SCRIPT },
      antelopeJs: { baseUrl: "dist", paths: { "@/*": ["*"] } },
    }),
  );
  put(
    root,
    "tsconfig.json",
    JSON.stringify({
      compilerOptions: {
        target: "ES2020",
        module: "commonjs",
        rootDir: "src",
        outDir: "dist",
        types: [],
        strict: true,
        noEmit: true,
        paths: { "@/*": ["./src/*"] },
      },
      include: ["src/**/*"],
    }),
  );
  put(root, "src/index.ts", 'export { value } from "@/value";\n');
  put(root, "src/value.ts", "export const value = 1;\n");
  commit(root);
  const same = bin(root, "api-diff", ["HEAD"]);
  assert.equal(same.status, 0, same.stdout + same.stderr);
  assert.match(same.stdout, /^API: 1 packages, 2 entries unchanged/m);
  assert.match(same.stdout, /^Runtime API: 1 packages, 1 entries unchanged/m);
  put(root, "src/value.ts", 'export const value = "one";\n');
  commit(root);
  const changed = bin(root, "api-diff", ["HEAD~1"]);
  assert.equal(changed.status, 1, changed.stdout + changed.stderr);
  assert.match(changed.stdout, /^-export declare const value = 1;$/m);
  assert.match(changed.stdout, /^\+export declare const value = "one";$/m);
  assert.match(changed.stdout, /^-\s+"kind": "number"$/m);
  assert.match(changed.stdout, /^\+\s+"kind": "string"$/m);
});
