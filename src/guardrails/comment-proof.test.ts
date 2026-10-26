import assert from "node:assert/strict";
import { rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  bin,
  commit,
  PACKAGE_ROOT,
  put,
  testRepo,
} from "./helpers/test-repo.ts";

test("comment-proof strips comments, ignores type errors and test deletions, includes private packages, and detects changed or missing JS", (t) => {
  const root = testRepo(t);
  symlinkSync(
    join(PACKAGE_ROOT, "node_modules"),
    join(root, "node_modules"),
    "dir",
  );
  put(root, "package.json", JSON.stringify({ private: true, type: "module" }));
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
        noEmit: true,
        noEmitOnError: true,
        declaration: true,
        sourceMap: true,
      },
      include: ["src/**/*.ts"],
    }),
  );
  put(
    root,
    "src/index.ts",
    "// oxlint-disable-next-line rule -- reason\n// SAFETY: old boundary\n// @ts-expect-error fixture\nexport const value: number = 'type error';\n",
  );
  put(root, "src/index.test.ts", "export const changedTest = 1;\n");
  put(root, "src/spare.ts", "export const spare = 5;\n");
  put(
    root,
    "output/tool.cjs",
    "// SAFETY: counted outside the size guard's scope\n",
  );
  commit(root);
  put(
    root,
    "src/index.ts",
    "// eslint-disable-next-line rule -- reason\n// oxlint-disable rule -- reason\n// SAFETY: new boundary\n// SAFETY: second boundary\nexport const value: number = 'type error';\n",
  );
  rmSync(join(root, "src/index.test.ts"));
  commit(root);
  const comments = bin(root, "comment-proof", ["HEAD~1"]);
  assert.equal(comments.status, 0, comments.stdout + comments.stderr);
  assert.match(
    comments.stdout,
    /1 packages, 2 entries unchanged.*committed HEAD/,
  );
  assert.match(
    comments.stdout,
    /\| oxlint-disable \/ eslint-disable directive lines \| 1 \| 2 \|/,
  );
  assert.match(comments.stdout, /\| SAFETY: lines \| 2 \| 3 \|/);
  assert.match(comments.stdout, /\| @ts-expect-error lines \| 1 \| 0 \|/);
  put(root, "src/index.ts", "export const value: number = 'runtime change';\n");
  assert.equal(bin(root, "comment-proof", ["HEAD~1"]).status, 0);
  commit(root);
  const code = bin(root, "comment-proof", ["HEAD~1"]);
  assert.equal(code.status, 1);
  assert.match(code.stdout, /-export const value = 'type error'/);
  assert.match(code.stdout, /\+export const value = 'runtime change'/);
  assert.match(code.stdout, /\| SAFETY: lines \| 3 \| 1 \|/);
  rmSync(join(root, "src/spare.ts"));
  commit(root);
  const missing = bin(root, "comment-proof", ["HEAD~1"]);
  assert.equal(missing.status, 1);
  assert.match(missing.stdout, /deleted file mode/);
  assert.match(missing.stdout, /spare\.js/);
});
