import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import {
  API_BUILD_SCRIPT,
  apiRepo,
  bin,
  commit,
  put,
} from "./helpers/test-repo.ts";

function aliasedRepo(
  t: TestContext,
  aliasOptions: { baseUrl?: string; paths: Record<string, string[]> },
): string {
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
        ...aliasOptions,
      },
      include: ["src/**/*"],
    }),
  );
  put(root, "src/index.ts", 'export { value } from "@/value";\n');
  put(root, "src/value.ts", "export const value = 1;\n");
  commit(root);
  return root;
}

function changeBehindAlias(root: string): void {
  put(root, "src/value.ts", 'export const value = "one";\n');
  commit(root);
}

function assertBothHalvesChanged(result: ReturnType<typeof bin>): void {
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /^-export declare const value = 1;$/m);
  assert.match(result.stdout, /^\+export declare const value = "one";$/m);
  assert.match(result.stdout, /^-\s+"kind": "number"$/m);
  assert.match(result.stdout, /^\+\s+"kind": "string"$/m);
}

const SOURCE_ALIAS = { paths: { "@/*": ["./src/*"] } };

test("api-diff follows a `@/` path alias in declarations and at runtime, so a change behind it shows in both halves", (t) => {
  const root = aliasedRepo(t, SOURCE_ALIAS);
  const same = bin(root, "api-diff", ["HEAD"]);
  assert.equal(same.status, 0, same.stdout + same.stderr);
  assert.match(same.stdout, /^API: 1 packages, 2 entries unchanged/m);
  assert.match(same.stdout, /^Runtime API: 1 packages, 1 entries unchanged/m);
  changeBehindAlias(root);
  assertBothHalvesChanged(bin(root, "api-diff", ["HEAD~1"]));
});

test("api-diff resolves `paths` targets against a tsconfig `baseUrl` that is not the config directory", (t) => {
  const root = aliasedRepo(t, { baseUrl: "./src", paths: { "@/*": ["*"] } });
  changeBehindAlias(root);
  assertBothHalvesChanged(bin(root, "api-diff", ["HEAD~1"]));
});

test("api-diff follows the runtime alias when the temporary directory is reached through a symlink", (t) => {
  const root = aliasedRepo(t, SOURCE_ALIAS);
  changeBehindAlias(root);
  const temporary = mkdtempSync(join(tmpdir(), "antelope-alias-link-"));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  mkdirSync(join(temporary, "real"));
  symlinkSync(join(temporary, "real"), join(temporary, "link"), "dir");
  assertBothHalvesChanged(
    bin(root, "api-diff", ["HEAD~1"], { TMPDIR: join(temporary, "link") }),
  );
});
