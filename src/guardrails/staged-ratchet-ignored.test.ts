import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdirSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";

import { formatCeilings } from "./ceilings.ts";
import { bin, commit, linkOxlint, put, testRepo } from "./helpers/test-repo.ts";

const SOURCE =
  "// Reads the text.\nexport function read(text: string) {\n  const parsed = JSON.parse(text);\n  return parsed;\n}\n";

/** A repository whose tsconfig extends a generated, gitignored one, as a Nuxt project's does, with one legacy finding the ceiling covers. */
function generatedConfigRepo(t: TestContext): string {
  const root = testRepo(t);
  linkOxlint(root);
  const require = createRequire(import.meta.url);
  symlinkSync(
    join(
      dirname(require.resolve("oxlint-tsgolint/package.json")),
      "bin/tsgolint.js",
    ),
    join(mkdirBin(root), "tsgolint"),
  );
  put(root, ".gitignore", "node_modules\n.generated\n");
  put(
    root,
    ".oxlintrc.json",
    JSON.stringify({
      categories: { correctness: "off" },
      plugins: ["typescript"],
      rules: { "typescript/no-unsafe-assignment": "error" },
      options: { typeAware: true },
    }),
  );
  put(
    root,
    "tsconfig.json",
    JSON.stringify({ extends: "./.generated/tsconfig.json" }),
  );
  put(
    root,
    ".generated/tsconfig.json",
    JSON.stringify({
      compilerOptions: { strict: true, noEmit: true, types: [] },
      include: ["../src/**/*.ts"],
    }),
  );
  put(root, "src/index.ts", SOURCE);
  put(
    root,
    "guardrails.ratchet.json",
    formatCeilings({
      rules: { "typescript/no-unsafe-assignment": 1 },
      oversizeFiles: {},
    }),
  );
  commit(root);
  return root;
}

function mkdirBin(root: string): string {
  const directory = join(root, "node_modules/.bin");
  mkdirSync(directory, { recursive: true });
  return directory;
}

test("staged ratchet agrees with the full run when the tsconfig extends a gitignored generated file", (t) => {
  const root = generatedConfigRepo(t);
  assert.equal(bin(root, "ratchet", []).status, 0);
  put(root, "src/index.ts", SOURCE.replace("Reads", "Parses"));
  execFileSync("git", ["add", "--", "src/index.ts"], { cwd: root });
  const result = bin(root, "ratchet", ["--staged", "src/index.ts"]);
  assert.equal(result.status, 0, result.stderr);
});

test("staged ratchet still fails a finding added under a gitignored generated tsconfig", (t) => {
  const root = generatedConfigRepo(t);
  put(root, "src/index.ts", `${SOURCE}export const again = JSON.parse("1");\n`);
  execFileSync("git", ["add", "--", "src/index.ts"], { cwd: root });
  const result = bin(root, "ratchet", ["--staged", "src/index.ts"]);
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /typescript\/no-unsafe-assignment: this commit adds 1/,
  );
});
