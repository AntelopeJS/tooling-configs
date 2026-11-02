import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import { formatCeilings } from "./ceilings.ts";
import { bin, commit, linkOxlint, put, testRepo } from "./helpers/test-repo.ts";

const FLOATING = "typescript/no-floating-promises";
const ANY = "typescript/no-explicit-any";
const TSGOLINT = fileURLToPath(
  new URL(
    "bin/tsgolint.js",
    import.meta.resolve("oxlint-tsgolint/package.json"),
  ),
);

function writeCeiling(root: string, rule: string, count: number): void {
  put(
    root,
    "guardrails.ratchet.json",
    formatCeilings({ rules: { [rule]: count }, oversizeFiles: {} }),
  );
}

function calls(count: number): string {
  return [
    'import { run } from "../gen/api.js";',
    "export function go(): void {",
    ...Array.from({ length: count }, () => "  run();"),
    "}",
    "",
  ].join("\n");
}

/** A repository whose generated types live in a gitignored `gen/`, so only the real tree resolves them. */
function typedRepo(t: TestContext) {
  const root = testRepo(t);
  linkOxlint(root);
  const require = createRequire(import.meta.url);
  symlinkSync(
    dirname(require.resolve("oxlint-tsgolint/package.json")),
    join(root, "node_modules/oxlint-tsgolint"),
    "dir",
  );
  put(root, ".gitignore", "node_modules\ngen/\n");
  put(
    root,
    ".oxlintrc.json",
    JSON.stringify({
      categories: { correctness: "off" },
      plugins: ["typescript"],
      options: { typeAware: true },
      rules: { [FLOATING]: "error" },
    }),
  );
  put(
    root,
    "tsconfig.json",
    JSON.stringify({
      compilerOptions: {
        strict: true,
        module: "nodenext",
        moduleResolution: "nodenext",
        noEmit: true,
        target: "es2022",
        skipLibCheck: true,
      },
      include: ["**/*.ts"],
      exclude: ["node_modules"],
    }),
  );
  put(root, "gen/api.d.ts", "export declare function run(): Promise<void>;\n");
  put(root, "gen/api.js", "export {};\n");
  put(root, "sub/legacy.ts", calls(2));
  writeCeiling(root, FLOATING, 2);
  commit(root);
  return root;
}

test("an approved type-aware raise is counted with the generated types the real tree has", (t) => {
  const root = typedRepo(t);
  put(root, "new.ts", calls(2).replaceAll("../gen", "./gen"));
  writeCeiling(root, FLOATING, 3);
  stageAll(root);
  const result = bin(root, "ratchet", ["--staged", "new.ts"], {
    APPROVED_RAISES: `${FLOATING}=3`,
    OXLINT_TSGOLINT_PATH: TSGOLINT,
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /holds 4 findings/);
});

test("an ignore file above TMPDIR does not hide a tracked file from the approved count", (t) => {
  const outer = mkdtempSync(join(tmpdir(), "antelope-above-"));
  t.after(() => rmSync(outer, { recursive: true, force: true }));
  put(outer, ".gitignore", "lib/\n");
  mkdirSync(join(outer, "tmp"));
  const root = testRepo(t);
  linkOxlint(root);
  put(
    root,
    ".oxlintrc.json",
    JSON.stringify({
      categories: { correctness: "off" },
      plugins: ["typescript"],
      rules: { [ANY]: "error" },
    }),
  );
  put(
    root,
    "lib/legacy.ts",
    "export const a: any = 1;\nexport const b: any = 2;\n",
  );
  writeCeiling(root, ANY, 2);
  commit(root);
  put(root, "new.ts", "export const c: any = 3;\nexport const d: any = 4;\n");
  writeCeiling(root, ANY, 3);
  stageAll(root);
  const result = bin(root, "ratchet", ["--staged", "new.ts"], {
    APPROVED_RAISES: `${ANY}=3`,
    TMPDIR: join(outer, "tmp"),
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /holds 4 findings/);
});

function stageAll(root: string): void {
  execFileSync("git", ["add", "-A"], { cwd: root });
}
