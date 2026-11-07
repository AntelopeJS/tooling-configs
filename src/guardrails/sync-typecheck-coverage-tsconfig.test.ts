import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { syncRepository } from "./sync.ts";
import { findingsFor } from "./helpers/coverage-repo.ts";
import { put, testRepo } from "./helpers/test-repo.ts";

const FULL = { typecheck: "tsc --noEmit" };
const SKIPS = '{ "compilerOptions": { "skipLibCheck": true } }';

test("every tsc launcher is recognised in build and in typecheck; a check that knows only a bare tsc misses the skipped program in build and the covering run in typecheck", (t) => {
  for (const tsc of [
    "node ./node_modules/typescript/bin/tsc",
    "npx tsc",
    "npx -p typescript tsc",
    "npx --no-install tsc",
    "pnpm exec tsc",
    "pnpm tsc",
    "yarn tsc",
    "bunx tsc",
  ]) {
    assert.match(
      findingsFor(t, { build: `${tsc} --skipLibCheck` })[0],
      /^package\.json: script "build" passes --skipLibCheck/,
      `build: ${tsc}`,
    );
    assert.deepEqual(
      findingsFor(t, {
        build: "tsc --skipLibCheck",
        typecheck: `${tsc} --noEmit`,
      }),
      [],
      `typecheck: ${tsc}`,
    );
  }
});

test("--skipLibCheck is read in any letter case; a case-sensitive flag match passes a build that skips the lib check", (t) => {
  for (const flag of ["--skiplibcheck", "--SKIPLIBCHECK", "--SkipLibCheck"])
    assert.match(
      findingsFor(t, { build: `tsc ${flag}` })[0],
      /script "build" passes --skipLibCheck/,
      flag,
    );
});

test("tsc -b reads the config it names and the projects it references; a check that looks only at -p misses a skipLibCheck behind -b", (t) => {
  const named = findingsFor(
    t,
    { build: "tsc -b tsconfig.build.json", ...FULL },
    { "tsconfig.json": "{}", "tsconfig.build.json": SKIPS },
  );
  assert.match(
    named.join("\n"),
    /^tsconfig\.build\.json: sets compilerOptions\.skipLibCheck: true, read by tsconfig\.build\.json \(script "build"\)/m,
  );
  const referenced = findingsFor(
    t,
    { build: "tsc --build", ...FULL },
    {
      "tsconfig.json": '{ "files": [], "references": [{ "path": "./lib" }] }',
      "lib/tsconfig.json": `{ "extends": "./base.json", "references": [{ "path": "../app/tsconfig.app.json" }] }`,
      "lib/base.json": "{}",
      "app/tsconfig.app.json": SKIPS,
    },
  );
  assert.match(
    referenced.join("\n"),
    /^app\/tsconfig\.app\.json: sets compilerOptions\.skipLibCheck: true, read by app\/tsconfig\.app\.json \(script "build"\)/m,
  );
});

test("extends to a .jsonc file or through backslashes is followed; a check that appends .json to everything or reads only slashes misses both", (t) => {
  for (const extended of ['"./base.jsonc"', '".\\\\configs\\\\base.json"']) {
    const path = extended.includes("jsonc")
      ? "base.jsonc"
      : "configs/base.json";
    assert.match(
      findingsFor(t, FULL, {
        "tsconfig.json": `{ "extends": ${extended} }`,
        [path]: SKIPS,
      }).join("\n"),
      new RegExp(`^${path.replace(".", "\\.")}: sets compilerOptions`, "m"),
      extended,
    );
  }
});

test("the last of a repeated key wins, as when tsc reads it; a check that takes the first passes the second order and fails the first", (t) => {
  assert.deepEqual(
    findingsFor(t, FULL, {
      "tsconfig.json":
        '{ "compilerOptions": { "skipLibCheck": true, "skipLibCheck": false } }',
    }),
    [],
  );
  assert.match(
    findingsFor(t, FULL, {
      "tsconfig.json":
        '{ "compilerOptions": { "skipLibCheck": false, "skipLibCheck": true } }',
    })[0],
    /^tsconfig\.json: sets compilerOptions\.skipLibCheck: true/,
  );
  assert.deepEqual(
    findingsFor(t, FULL, {
      "tsconfig.json":
        '{ "compilerOptions": { "skipLibCheck": true }, "compilerOptions": { "strict": true } }',
    }),
    [],
  );
});

test("a generated tsconfig in the extends chain is not edited: the finding names the first tracked file with the fix to set skipLibCheck false there; a check that names the setter tells the user to edit .nuxt/tsconfig.json", (t) => {
  const findings = findingsFor(t, FULL, {
    ".gitignore": "node_modules\n.nuxt\n",
    "tsconfig.json": '{ "extends": "./.nuxt/tsconfig.json" }',
    ".nuxt/tsconfig.json": SKIPS,
  });
  assert.equal(findings.length, 1);
  assert.match(
    findings[0],
    /^tsconfig\.json: inherits compilerOptions\.skipLibCheck: true from \.nuxt\/tsconfig\.json, which git ignores/,
  );
  assert.match(findings[0], /Set `skipLibCheck: false` here/);
  assert.doesNotMatch(findings[0], /^\.nuxt/);
});

test("a chain with no tracked file reports nothing; a check that falls back to the generated file reports it", (t) => {
  assert.deepEqual(
    findingsFor(
      t,
      { typecheck: "tsc --noEmit -p .nuxt/tsconfig.json" },
      {
        ".gitignore": "node_modules\n.nuxt\n",
        "tsconfig.json": "{}",
        ".nuxt/tsconfig.json": SKIPS,
      },
    ),
    [],
  );
});

test("a tracked file between two generated ones is the one reported; a check that reports the program or the setter names a file nobody can edit", (t) => {
  const findings = findingsFor(
    t,
    { typecheck: "tsc --noEmit -p .nuxt/tsconfig.app.json" },
    {
      ".gitignore": "node_modules\n.nuxt\n",
      "tsconfig.json": "{}",
      "base.json": '{ "extends": "./.nuxt/tsconfig.json" }',
      ".nuxt/tsconfig.app.json": '{ "extends": "../base.json" }',
      ".nuxt/tsconfig.json": SKIPS,
    },
  );
  assert.equal(findings.length, 1);
  assert.match(
    findings[0],
    /^base\.json: inherits compilerOptions\.skipLibCheck: true from \.nuxt\/tsconfig\.json/,
  );
});

test("a directory where a tsconfig or a release-it config is expected becomes a Note and sync still succeeds; a check that lets the read throw fails sync", (t) => {
  const root = testRepo(t);
  put(
    root,
    "package.json",
    JSON.stringify({
      name: "read-error",
      type: "module",
      packageManager: "pnpm@10.0.0",
      scripts: { release: "release-it", ...FULL },
    }),
  );
  mkdirSync(join(root, "tsconfig.json"));
  put(root, "tsconfig.json/keep", "");
  mkdirSync(join(root, ".release-it.json"));
  put(root, ".release-it.json/keep", "");
  const notes = syncRepository(root, { check: true })
    .advisories.filter((line) => line.startsWith("Note: "))
    .join("\n");
  assert.match(notes, /Note: could not read tsconfig\.json \(EISDIR\)/);
  assert.match(notes, /Note: could not read \.release-it\.json \(EISDIR\)/);
});
