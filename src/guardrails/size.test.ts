import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { formatCeilings, MAX_FILE_BYTES } from "./ceilings.ts";
import { bin, commit, put, testRepo } from "./helpers/test-repo.ts";

test("size catches untracked tests and real byte excess, not only tracked source or character counts", (t) => {
  const root = testRepo(t);
  for (const path of [
    "pnpm-lock.yaml",
    "package-lock.json",
    "nested/yarn.lock",
    "docs/guide.md",
    "CHANGELOG.md",
    "fixtures/large.ts",
    "src/__fixtures__/large.ts",
    "dist/large.js",
    "src/code.generated.ts",
    "src/generated/client.ts",
    "src/__snapshots__/large.snap",
    "image.png",
    ".github/social-card.png",
    ".agents/fixtures/large.ts",
  ])
    put(root, path, "x".repeat(MAX_FILE_BYTES + 1));
  put(root, "boundary.ts", "x".repeat(MAX_FILE_BYTES));
  put(root, ".github/scripts/large.ts", "x".repeat(MAX_FILE_BYTES + 1));
  put(root, "deleted.ts", "x".repeat(MAX_FILE_BYTES + 1));
  commit(root);
  rmSync(join(root, "deleted.ts"));
  const dotted = bin(root, "check-size");
  assert.equal(dotted.status, 1);
  assert.match(dotted.stderr, /^\.github\/scripts\/large\.ts: /mu);
  assert.doesNotMatch(dotted.stderr, /social-card|\.agents/u);
  rmSync(join(root, ".github/scripts/large.ts"));
  assert.equal(bin(root, "check-size").status, 0);
  put(root, "src/clock.test.ts", "é".repeat(10_001));
  const result = bin(root, "check-size");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /src\/clock.test.ts: 20002 bytes, 2 bytes over/);
  for (const text of [
    "sibling modules",
    "one cohesive group of exports",
    "public entry point",
    "one file per describe",
    "Do not minify, strip whitespace",
    "excluded path",
  ])
    assert.ok(result.stderr.includes(text), text);
  assert.equal(
    bin(root, "check-size", ["boundary.ts", "deleted.ts"]).status,
    0,
  );
  assert.equal(bin(root, "check-size", ["src/clock.test.ts"]).status, 1);
});

test("size excludes every JSON file and NUL-bearing binaries, not oversized code or late NULs", (t) => {
  const root = testRepo(t);
  for (const path of [
    "locales/en.json",
    "src/locales/nested/fr.json",
    "i18n/fr.json",
    "blocks.json",
    "nested/schema.json",
    "evals/cases.json",
    "nested/evals/suite/cases.json",
    "packages/dms/docs-data/examples.json",
    "authored.json",
    "tsconfig.jsonc",
    ".config/settings.json5",
  ])
    put(root, path, JSON.stringify("x".repeat(MAX_FILE_BYTES)));
  put(root, "opaque.custom", `\0${"x".repeat(MAX_FILE_BYTES)}`);
  commit(root);
  assert.equal(bin(root, "check-size").status, 0);
  execFileSync("git", ["add", "packages/dms/docs-data/examples.json"], {
    cwd: root,
  });
  assert.equal(
    bin(root, "check-size", [
      "--staged",
      "packages/dms/docs-data/examples.json",
    ]).status,
    0,
  );
  put(root, "opaque.custom", "x".repeat(MAX_FILE_BYTES + 1));
  assert.equal(
    bin(root, "check-size", ["--staged", "opaque.custom"]).status,
    0,
  );
  assert.equal(bin(root, "check-size", ["opaque.custom"]).status, 1);
  execFileSync("git", ["add", "opaque.custom"], { cwd: root });
  put(root, "opaque.custom", `\0${"x".repeat(MAX_FILE_BYTES)}`);
  assert.equal(
    bin(root, "check-size", ["--staged", "opaque.custom"]).status,
    1,
  );
  put(root, "authored.ts", "x".repeat(MAX_FILE_BYTES + 1));
  put(
    root,
    "late.custom",
    `${"x".repeat(8000)}\0${"x".repeat(MAX_FILE_BYTES)}`,
  );
  const result = bin(root, "check-size");
  assert.match(result.stderr, /authored\.ts:/);
  assert.doesNotMatch(result.stderr, /\.json/u);
  assert.match(result.stderr, /late\.custom:/);
});

test("size honours a recorded allowance but rejects one byte of growth instead of exempting the path", (t) => {
  const root = testRepo(t);
  put(root, "large.ts", "x".repeat(20_123));
  put(
    root,
    "guardrails.ratchet.json",
    formatCeilings({ rules: {}, oversizeFiles: { "large.ts": 20_123 } }),
  );
  assert.equal(bin(root, "check-size").status, 0);
  put(root, "large.ts", "x".repeat(20_124));
  const result = bin(root, "check-size", ["large.ts"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /1 bytes over the 20123-byte ceiling/);
});

test("staged size checks the index blob rather than the working tree in both directions", (t) => {
  const root = testRepo(t);
  put(root, "large.ts", "x".repeat(20_001));
  execFileSync("git", ["add", "large.ts"], { cwd: root });
  put(root, "large.ts", "small\n");
  const oversized = bin(root, "check-size", ["--staged", "large.ts"]);
  assert.equal(oversized.status, 1);
  assert.match(oversized.stderr, /large.ts: 20001 bytes/);
  execFileSync("git", ["add", "large.ts"], { cwd: root });
  put(root, "large.ts", "x".repeat(20_001));
  assert.equal(bin(root, "check-size", ["--staged", "large.ts"]).status, 0);
});

test("size rejects disable directives without a rule list, in line and block form, in staged blobs too, but not directive text in strings", (t) => {
  const root = testRepo(t);
  const blanket = "eslint-disable";
  put(
    root,
    "named.ts",
    `// ${blanket}-next-line no-debugger -- probe\ndebugger;\n`,
  );
  assert.equal(bin(root, "check-size").status, 0);
  put(root, "block.ts", `/* ${blanket} */\n// a stale comment\n`);
  put(root, "line.ts", `run(); // oxlint-disable-line\n`);
  put(root, "quoted.ts", `export const probe = "// ${blanket}-line";\n`);
  const result = bin(root, "check-size");
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /block\.ts:1: `eslint-disable` without a rule list/,
  );
  assert.match(
    result.stderr,
    /line\.ts:1: `oxlint-disable-line` without a rule list/,
  );
  assert.doesNotMatch(result.stderr, /named\.ts|quoted\.ts/);
  commit(root);
  put(root, "block.ts", "export const clean = true;\n");
  assert.equal(bin(root, "check-size", ["--staged", "block.ts"]).status, 1);
});

test("size measures authored build and output directories below the root and excludes only generated roots", (t) => {
  const root = testRepo(t);
  const big = "x".repeat(MAX_FILE_BYTES + 1);
  for (const path of [
    "dist/x.js",
    "build/x.js",
    "output/x.js",
    "packages/lib/build/x.js",
    "packages/lib/output/x.js",
    "packages/lib/dist/x.js",
    ".output/x.js",
    ".nuxt/x.js",
    "coverage/x.js",
  ])
    put(root, path, big);
  put(root, "packages/lib/package.json", "{}\n");
  commit(root);
  assert.equal(bin(root, "check-size").status, 0);
  for (const path of [
    "src/core/output/x.ts",
    "src/core/build/x.ts",
    "test/core/cli/output/x.test.ts",
    "src/build/x.ts",
    "packages/lib/src/output/x.ts",
    "tools/build/x.ts",
  ])
    put(root, path, big);
  const result = bin(root, "check-size");
  assert.equal(result.status, 1);
  const flagged = [...result.stderr.matchAll(/^(\S+): \d+ bytes/gmu)]
    .map(([, file]) => file)
    .sort();
  assert.deepEqual(flagged, [
    "packages/lib/src/output/x.ts",
    "src/build/x.ts",
    "src/core/build/x.ts",
    "src/core/output/x.ts",
    "test/core/cli/output/x.test.ts",
    "tools/build/x.ts",
  ]);
});
