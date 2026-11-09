import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  bin,
  commit,
  PACKAGE_ROOT,
  put,
  testRepo,
} from "./helpers/test-repo.ts";

test("comment-proof keeps a tracked node_modules symlink whose target is linked later", (t) => {
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
      },
      include: ["src/**/*.ts"],
    }),
  );
  put(root, "src/index.ts", "export const value = 1;\n");
  put(root, "packages/lib/package.json", JSON.stringify({ private: true }));
  mkdirSync(join(root, "packages/lib/node_modules"));
  put(
    root,
    ".agents/playground/package.json",
    JSON.stringify({ private: true }),
  );
  symlinkSync(
    "../../packages/lib/node_modules",
    join(root, ".agents/playground/node_modules"),
    "dir",
  );
  execFileSync("git", ["add", "-f", ".agents/playground/node_modules"], {
    cwd: root,
  });
  commit(root);
  put(root, "src/index.ts", "/** Documented. */\nexport const value = 1;\n");
  commit(root);
  const proof = bin(root, "comment-proof", ["HEAD~1"]);
  assert.equal(proof.status, 0, proof.stdout + proof.stderr);
  assert.match(proof.stdout, /entries unchanged.*committed HEAD/);
});
