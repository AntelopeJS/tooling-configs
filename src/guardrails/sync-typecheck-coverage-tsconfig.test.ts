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
    "antelopejs-tsc",
    "npx antelopejs-tsc",
    "npx --no-install antelopejs-tsc",
    "pnpm exec antelopejs-tsc",
    "pnpm antelopejs-tsc",
    "yarn antelopejs-tsc",
    "bunx antelopejs-tsc",
    "node ./node_modules/.bin/antelopejs-tsc",
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

test("a tracked tsconfig that only extends a git-ignored one setting skipLibCheck true is not refused, under .nuxt and under .dms-types; a check that reports the first tracked file of the chain refuses it", (t) => {
  for (const dir of [".nuxt", ".dms-types"])
    assert.deepEqual(
      findingsFor(t, FULL, {
        ".gitignore": `node_modules\n${dir}\n`,
        "tsconfig.json": `{ "extends": "./${dir}/tsconfig.json" }`,
        [`${dir}/tsconfig.json`]: SKIPS,
      }),
      [],
      dir,
    );
});

test("a tracked file that sets skipLibCheck true is refused even when it extends a git-ignored tsconfig; a check that skips every chain through an ignored file passes it", (t) => {
  const findings = findingsFor(t, FULL, {
    ".gitignore": "node_modules\n.dms-types\n",
    "tsconfig.json":
      '{ "extends": "./.dms-types/tsconfig.json", "compilerOptions": { "skipLibCheck": true } }',
    ".dms-types/tsconfig.json": "{}",
  });
  assert.equal(findings.length, 1);
  assert.match(
    findings[0],
    /^tsconfig\.json: sets compilerOptions\.skipLibCheck: true/,
  );
});

test("a tracked file between two ignored ones that sets skipLibCheck true is refused, one inheriting it from a tracked setter through an ignored file too; a check that stops at the first ignored file passes it", (t) => {
  const findings = findingsFor(
    t,
    { typecheck: "tsc --noEmit -p .nuxt/tsconfig.app.json" },
    {
      ".gitignore": "node_modules\n.nuxt\n",
      "tsconfig.json": "{}",
      "base.json": SKIPS,
      ".nuxt/tsconfig.app.json": '{ "extends": "../base.json" }',
    },
  );
  assert.equal(findings.length, 1);
  assert.match(
    findings[0],
    /^base\.json: sets compilerOptions\.skipLibCheck: true/,
  );
});

test("a directory where a tsconfig or a release-it config is expected becomes a Note and never a --check error; a check that lets the read throw, or fails --check on it, fails this", (t) => {
  const root = testRepo(t);
  put(
    root,
    "package.json",
    JSON.stringify({
      name: "read-error",
      type: "module",
      packageManager: "pnpm@10.33.0",
      scripts: { release: "release-it", ...FULL },
    }),
  );
  mkdirSync(join(root, "tsconfig.json"));
  put(root, "tsconfig.json/keep", "");
  mkdirSync(join(root, ".release-it.json"));
  put(root, ".release-it.json/keep", "");
  const result = syncRepository(root, { check: true });
  const notes = result.advisories.join("\n");
  assert.match(notes, /Note: could not read tsconfig\.json \(EISDIR\)/);
  assert.match(notes, /Note: could not read \.release-it\.json \(EISDIR\)/);
  assert.doesNotMatch(result.errors.join("\n"), /could not read/);
});

test("a repository whose build and typecheck run antelopejs-tsc keeps every lib check rule: a skipped program typecheck does not cover, a tsconfig that sets skipLibCheck, and a release without typecheck each fail; a check that knows only tsc passes the first two", (t) => {
  const uncovered = findingsFor(t, {
    build: "antelopejs-tsc --skipLibCheck -p tsconfig.build.json",
    typecheck: "antelopejs-tsc --noEmit",
  });
  assert.match(
    uncovered.join("\n"),
    /script "build" passes --skipLibCheck to antelopejs-tsc for tsconfig\.build\.json/,
  );
  assert.match(
    uncovered.join("\n"),
    /Make "typecheck" run `antelopejs-tsc --noEmit -p tsconfig\.build\.json`/,
  );
  const skipping = findingsFor(
    t,
    { typecheck: "antelopejs-tsc --noEmit -p tsconfig.build.json" },
    { "tsconfig.json": "{}", "tsconfig.build.json": SKIPS },
  );
  assert.match(skipping.join("\n"), /tsconfig\.build\.json/);
  const release = findingsFor(t, {
    typecheck: "antelopejs-tsc --noEmit",
    build: "antelopejs-tsc",
    release: "pnpm run build && release-it",
  });
  assert.match(release.join("\n"), /script "release" does not run "typecheck"/);
  assert.deepEqual(
    findingsFor(t, {
      typecheck: "antelopejs-tsc --noEmit",
      build: "antelopejs-tsc --skipLibCheck",
      release: "pnpm run typecheck && pnpm run build && release-it",
    }),
    [],
  );
});

test("tsc -b reads the values of its string options and an explicit boolean as values, not projects; a check that takes each word after -b for a project reports 2/tsconfig.json as unchecked", (t) => {
  assert.deepEqual(
    findingsFor(
      t,
      {
        build:
          "antelopejs-tsc -b --builders 2 --checkers 4 --pprofDir prof --locale fr --generateTrace trace --generateCpuProfile cpu.cpuprofile --pretty false tsconfig.build.json --skipLibCheck",
        typecheck: "antelopejs-tsc -b tsconfig.build.json",
      },
      { "tsconfig.json": "{}", "tsconfig.build.json": "{}" },
    ),
    [],
  );
});
