import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import {
  API_BUILD_SCRIPT,
  apiRepo,
  bin,
  commit,
  put,
  read,
} from "./helpers/test-repo.ts";

const ROOT_ENTRY = { types: "./dist/index.d.ts", default: "./dist/index.js" };

function scriptsRepo(t: TestContext) {
  const root = apiRepo(t);
  const manifest = JSON.parse(read(root, "package.json"));
  put(
    root,
    "package.json",
    JSON.stringify({
      ...manifest,
      exports: {
        ".": ROOT_ENTRY,
        "./scripts/*": {
          types: "./dist/scripts/*.d.ts",
          default: "./dist/scripts/*.js",
        },
      },
    }),
  );
  put(root, "src/index.ts", "export const value = 1;\n");
  put(root, "src/scripts/kept.ts", "export const kept = 1;\n");
  put(
    root,
    "src/scripts/build.ts",
    'throw new Error("build script ran on import");\nexport {};\n',
  );
  commit(root);
  return root;
}

test("api-diff fails on a published entry that throws on import unless --skip-runtime names its subpath, and then says it skipped it", (t) => {
  const root = scriptsRepo(t);
  const loaded = bin(root, "api-diff", ["HEAD"]);
  assert.equal(loaded.status, 1, loaded.stdout + loaded.stderr);
  assert.match(loaded.stdout, /Execution error:.*build script ran on import/s);

  const skipped = bin(root, "api-diff", [
    "HEAD",
    "--skip-runtime",
    "scripts/build",
  ]);
  assert.equal(skipped.status, 0, skipped.stdout + skipped.stderr);
  assert.match(skipped.stdout, /^API: 1 packages, 3 entries unchanged/m);
  assert.match(
    skipped.stdout,
    /^Runtime API: 1 packages, 2 entries unchanged/m,
  );
  assert.match(
    skipped.stdout,
    /^Runtime API: skipped entry scripts\/build in \., which --skip-runtime names\.$/m,
  );
  assert.doesNotMatch(skipped.stdout, /skipped entry scripts\/kept/);
});

function wildcardPackage(root: string): void {
  put(root, "pnpm-workspace.yaml", "packages:\n  - lib\n");
  put(
    root,
    "lib/package.json",
    JSON.stringify({
      name: "lib",
      type: "module",
      scripts: { build: API_BUILD_SCRIPT },
      exports: {
        ".": ROOT_ENTRY,
        "./*": { types: "./dist/*.d.ts", default: "./*" },
      },
    }),
  );
  put(root, "lib/tsconfig.json", read(root, "tsconfig.json"));
  put(root, "lib/src/index.ts", "export const value = 1;\n");
  put(root, "src/index.ts", "export const value = 1;\n");
}

test("api-diff leaves the package's node_modules out of a ./* export, since Node never resolves a subpath through it", (t) => {
  const root = apiRepo(t);
  wildcardPackage(root);
  put(
    root,
    "lib/node_modules/dependency/index.js",
    'throw new Error("dependency loaded");\n',
  );
  commit(root);
  const result = bin(root, "api-diff", ["HEAD"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^Runtime API: 2 packages, 3 entries unchanged/m);
});

test(
  "api-diff scans a ./* export inside its package, not the directory around it",
  {
    skip:
      process.platform === "win32" || process.getuid?.() === 0
        ? "needs a directory the test user cannot read"
        : false,
  },
  (t) => {
    const root = apiRepo(t);
    wildcardPackage(root);
    const locked = mkdtempSync(join(tmpdir(), "antelope-locked-"));
    chmodSync(locked, 0o000);
    t.after(() => {
      chmodSync(locked, 0o700);
      rmSync(locked, { recursive: true, force: true });
    });
    put(root, "sibling/README.md", "Outside lib.\n");
    symlinkSync(locked, join(root, "sibling/locked"), "dir");
    commit(root);
    const result = bin(root, "api-diff", ["HEAD"]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(
      result.stdout,
      /^Runtime API: 2 packages, 3 entries unchanged/m,
    );
  },
);
