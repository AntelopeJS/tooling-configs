import { symlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { TestContext } from "node:test";

import { formatCeilings } from "../ceilings.ts";
import { commit, linkOxlint, put, testRepo } from "./test-repo.ts";

export const FLOATING = "typescript/no-floating-promises";

export function writeCeiling(root: string, rule: string, count: number): void {
  put(
    root,
    "guardrails.ratchet.json",
    formatCeilings({ rules: { [rule]: count }, oversizeFiles: {} }),
  );
}

export function calls(count: number): string {
  return [
    'import { run } from "../gen/api.js";',
    "export function go(): void {",
    ...Array.from({ length: count }, () => "  run();"),
    "}",
    "",
  ].join("\n");
}

/** A repository whose generated types live in a gitignored `gen/`, so only the real tree resolves them. */
export function typedRepo(t: TestContext) {
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
