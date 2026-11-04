import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, symlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import { formatCeilings, readCeilings } from "./ceilings.ts";
import { bin, commit, linkOxlint, put, testRepo } from "./helpers/test-repo.ts";

const ENV = {
  OXLINT_TSGOLINT_PATH: fileURLToPath(
    new URL(
      "bin/tsgolint.js",
      import.meta.resolve("oxlint-tsgolint/package.json"),
    ),
  ),
};

const UNSAFE_ASSIGNMENT = "typescript/no-unsafe-assignment";

const LEGACY = `export function first(text: string): string[] {
  const rows: string[] = JSON.parse(text);
  return rows;
}

export function second(text: string): number[] {
  const rows: number[] = JSON.parse(text);
  return rows;
}
`;

const ADDED = `export function added(text: string): boolean[] {
  const rows: boolean[] = JSON.parse(text);
  return rows;
}
`;

/** A pnpm-style workspace on the pack release before the rule was enabled, whose package project loads its `@types/node` only from the package's own `node_modules`. */
function workspaceRepo(t: TestContext): string {
  const root = testRepo(t);
  linkOxlint(root);
  const require = createRequire(import.meta.url);
  const tsgolint = join(
    dirname(require.resolve("oxlint-tsgolint/package.json")),
    "bin/tsgolint.js",
  );
  mkdirSync(join(root, "node_modules/.bin"), { recursive: true });
  symlinkSync(tsgolint, join(root, "node_modules/.bin/tsgolint"));
  mkdirSync(join(root, "packages/a/node_modules/@types"), { recursive: true });
  symlinkSync(
    dirname(require.resolve("@types/node/package.json")),
    join(root, "packages/a/node_modules/@types/node"),
    "dir",
  );
  put(
    root,
    ".oxlintrc.json",
    JSON.stringify({
      options: { typeAware: true },
      categories: { correctness: "off" },
      plugins: ["typescript"],
      rules: { [UNSAFE_ASSIGNMENT]: "error" },
    }),
  );
  put(
    root,
    "tsconfig.json",
    JSON.stringify({ files: [], compilerOptions: { strict: true } }),
  );
  put(root, "packages/a/package.json", JSON.stringify({ name: "a" }));
  put(
    root,
    "packages/a/tsconfig.json",
    JSON.stringify({
      extends: "../../tsconfig.json",
      compilerOptions: { types: ["node"], noEmit: true },
      include: ["src/**/*.ts"],
    }),
  );
  put(root, "packages/a/src/legacy.ts", LEGACY);
  put(
    root,
    "guardrails.ratchet.json",
    formatCeilings({ pack: "0.2.16", rules: {}, oversizeFiles: {} }),
  );
  commit(root);
  return root;
}

function head(root: string): string {
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
}

function ratchet(root: string, ...args: string[]) {
  return bin(root, "ratchet", args, ENV);
}

test("#85 in a workspace: a resync adopts the count the base holds, resolving each package's own node_modules", (t) => {
  const root = workspaceRepo(t);
  const base = head(root);
  put(root, "README.md", "resynced\n");
  commit(root);
  const update = ratchet(root, "--update", "--base", base);
  assert.equal(update.status, 0, `${update.stdout}${update.stderr}`);
  assert.equal(readCeilings(root).rules[UNSAFE_ASSIGNMENT], 2);
  commit(root);
  const check = ratchet(root, "--base", base);
  assert.equal(check.status, 0, `${check.stdout}${check.stderr}`);
});

test("#85 in a workspace: a finding the branch adds is still refused above the base's count", (t) => {
  const root = workspaceRepo(t);
  const base = head(root);
  put(root, "packages/a/src/added.ts", ADDED);
  commit(root);
  const update = ratchet(root, "--update", "--base", base);
  assert.equal(update.status, 1, `${update.stdout}${update.stderr}`);
  assert.match(
    update.stderr,
    /adds typescript\/no-unsafe-assignment at 3, above its 2 findings on the base\./,
  );
});
