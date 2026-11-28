import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import { parseManifest } from "./package.ts";
import { bin, commit, put, read, testRepo } from "./helpers/test-repo.ts";
import { checkTestTimeouts, timedScript } from "./test-timeout.ts";

function withScripts(
  root: string,
  scripts: Record<string, string>,
  path = "package.json",
): void {
  const manifest = parseManifest(
    path === "package.json" ? read(root, path) : '{ "name": "member" }',
  );
  manifest.scripts = { ...manifest.scripts, ...scripts };
  put(root, path, `${JSON.stringify(manifest, null, 2)}\n`);
}

function errorsFor(t: TestContext, scripts: Record<string, string>): string[] {
  const root = testRepo(t);
  withScripts(root, scripts);
  return checkTestTimeouts(root, true).errors;
}

test("the hand-set limits of dms-database, rethinkdb and cloud's default each fail, naming the script, the limit and the fix; a check that reads only the test script passes cloud's integration run", (t) => {
  const errors = errorsFor(t, {
    test: '([ -n "$DMS_PREBUILT" ] || pnpm run build) && DMS_PREBUILT=1 ajs module test . --timeout 30000 && ajs module test . --timeout 10000',
    "test:integration": "pnpm run build && ajs module test .",
    "test:infra": "mocha scripts/test-infra.cjs",
  });
  assert.deepEqual(errors, [
    'package.json script "test" runs ajs module test with its own --timeout 10000; set --timeout 30000, the shared CI test timeout.',
    `package.json script "test:integration" runs ajs module test without --timeout, so it runs on mocha's 2000 ms default or a .mocharc limit; add --timeout 30000, the shared CI test timeout.`,
    `package.json script "test:infra" runs mocha without --timeout, so it runs on mocha's 2000 ms default or a .mocharc limit; add --timeout 30000, the shared CI test timeout.`,
  ]);
});

test("every spelling of the shared timeout passes, through pnpm exec, npx and a path to mocha; a check that accepts only `--timeout <ms>` reports them", (t) => {
  assert.deepEqual(
    errorsFor(t, {
      a: "ajs module test . --timeout=30000",
      b: "pnpm exec ajs module test . -f dist/a.test.js --timeout 30000",
      c: "npx mocha -t 30000 'dist/**/*.test.js'",
      d: "node_modules/.bin/mocha --timeout=30000",
      e: "pnpm run build && node --test && vitest run",
    }),
    [],
  );
});

test("runs through a manager bin, a coverage wrapper or node running mocha by path are read; a check that knows only the bare command words passes them", (t) => {
  const scripts = {
    a: "pnpm mocha 'dist/**/*.test.js'",
    b: "yarn mocha",
    c: "pnpm ajs module test .",
    d: "c8 --reporter text ajs module test .",
    e: "nyc mocha",
    f: "node ./node_modules/mocha/bin/mocha.js",
    g: "node node_modules/.bin/_mocha",
  };
  assert.deepEqual(
    errorsFor(t, scripts).map((error) => error.split(" runs ")[0]),
    Object.keys(scripts).map((name) => `package.json script "${name}"`),
  );
});

test("the last timeout flag wins and -t counts only for mocha, whose short flag ajs module test does not take; a check that reads the first flag, or -t for both runners, passes these", (t) => {
  const errors = errorsFor(t, {
    a: "ajs module test . --timeout 30000 --timeout 10000",
    b: "ajs module test . -t 30000",
    c: "mocha --timeout 30000 -t 5000",
  });
  assert.deepEqual(
    errors.map((error) => error.split("; ")[0]),
    [
      'package.json script "a" runs ajs module test with its own --timeout 10000',
      `package.json script "b" runs ajs module test without --timeout, so it runs on mocha's 2000 ms default or a .mocharc limit`,
      'package.json script "c" runs mocha with its own --timeout 5000',
    ],
  );
});

test("a workspace member's hand-set limit fails under its own path, as dms-media's does; a check that reads only the root manifest passes it", (t) => {
  const root = testRepo(t);
  put(root, "pnpm-workspace.yaml", "packages:\n  - packages/*\n");
  withScripts(
    root,
    {
      "test:unit":
        '[ -n "$DMS_PREBUILT" ] || pnpm run build && DMS_MEDIA_TEST_DIR=dist/test/unit ajs module test . --timeout 10000',
    },
    "packages/dms-media/package.json",
  );
  assert.deepEqual(checkTestTimeouts(root, true).errors, [
    'packages/dms-media/package.json script "test:unit" runs ajs module test with its own --timeout 10000; set --timeout 30000, the shared CI test timeout.',
  ]);
});

test("sync puts each run the check reads on the shared timeout and keeps the rest of the script; a rewrite that only appends the flag, or edits one runner's flags, leaves these failing", (t) => {
  const scripts = {
    "dms-database": [
      '([ -n "$DMS_PREBUILT" ] || pnpm run build) && DMS_PREBUILT=1 ajs module test . --timeout 30000 && ajs module test . --timeout 10000',
      '([ -n "$DMS_PREBUILT" ] || pnpm run build) && DMS_PREBUILT=1 ajs module test . --timeout 30000 && ajs module test . --timeout 30000',
    ],
    rethinkdb: [
      "pnpm run build && ajs module test . --timeout 10000",
      "pnpm run build && ajs module test . --timeout 30000",
    ],
    "cloud integration": [
      "pnpm run build && ajs module test .",
      "pnpm run build && ajs module test . --timeout 30000",
    ],
    "cloud infra": [
      "mocha scripts/test-infra.cjs",
      "mocha scripts/test-infra.cjs --timeout 30000",
    ],
    "dms-media": [
      '[ -n "$DMS_PREBUILT" ] || pnpm run build && DMS_MEDIA_TEST_DIR=dist/test/unit ajs module test . --timeout 10000',
      '[ -n "$DMS_PREBUILT" ] || pnpm run build && DMS_MEDIA_TEST_DIR=dist/test/unit ajs module test . --timeout 30000',
    ],
    inline: [
      "ajs module test . --timeout=10000 -f dist/a.test.js",
      "ajs module test . --timeout=30000 -f dist/a.test.js",
    ],
    "every flag": [
      "mocha --timeout 30000 -t 5000",
      "mocha --timeout 30000 -t 30000",
    ],
    "ajs short flag": [
      "ajs module test . -t 30000",
      "ajs module test . -t 30000 --timeout 30000",
    ],
    "manager bin": [
      "pnpm mocha 'dist/**/*.test.js'",
      "pnpm mocha 'dist/**/*.test.js' --timeout 30000",
    ],
    "exec in a member": [
      "pnpm --filter a exec mocha",
      "pnpm --filter a exec mocha --timeout 30000",
    ],
    wrapped: [
      "c8 --reporter text ajs module test .",
      "c8 --reporter text ajs module test . --timeout 30000",
    ],
    "in a group": [
      "(cd packages/a && mocha) || true",
      "(cd packages/a && mocha --timeout 30000) || true",
    ],
    "node bin": [
      "node ./node_modules/mocha/bin/mocha.js",
      "node ./node_modules/mocha/bin/mocha.js --timeout 30000",
    ],
    "rethinkdb external": [
      "RETHINK_TEST_MODE=external ajs module test . $(for file in dist/test-external/*.test.js; do printf -- '-f %s ' \"$file\"; done)",
      "RETHINK_TEST_MODE=external ajs module test --timeout 30000 . $(for file in dist/test-external/*.test.js; do printf -- '-f %s ' \"$file\"; done)",
    ],
    redirected: ["mocha > mocha.log", "mocha --timeout 30000 > mocha.log"],
    continued: ["mocha \\\n  dist", "mocha --timeout 30000 \\\n  dist"],
    "no test run": [
      "pnpm run build && node --test && vitest run",
      "pnpm run build && node --test && vitest run",
    ],
  } satisfies Record<string, [string, string]>;
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(scripts).map(([name, [script]]) => [
        name,
        timedScript(script),
      ]),
    ),
    Object.fromEntries(
      Object.entries(scripts).map(([name, [, timed]]) => [name, timed]),
    ),
  );
  assert.deepEqual(
    errorsFor(
      t,
      Object.fromEntries(
        Object.entries(scripts).map(([name, [, timed]]) => [name, timed]),
      ),
    ),
    [],
  );
});

test("a run in shell syntax the parser does not read is left as it is; a rewrite that edits every recognised run breaks these scripts", () => {
  for (const script of [
    'sh -c "pnpm build && mocha"',
    "mocha --timeout 10000 > mocha.log",
    "SPECS=$(cat specs) mocha",
    "mocha --timeout",
    "mocha -- --timeout 10000",
  ])
    assert.equal(timedScript(script), script);
});

test("sync --check fails on a hand-set limit and a write run sets the shared timeout in the root and member manifests, printing a Note only for a run it cannot rewrite; a sync that never runs the check passes the repository, and one that only reports leaves the limit", (t) => {
  const root = testRepo(t);
  assert.equal(bin(root, "sync").status, 0);
  put(root, "pnpm-workspace.yaml", "packages:\n  - packages/*\n");
  withScripts(root, {
    test: "ajs module test . --timeout 10000",
    log: "mocha --timeout 10000 > mocha.log",
  });
  withScripts(
    root,
    { test: "pnpm run build && ajs module test ." },
    "packages/member/package.json",
  );
  commit(root);
  const finding =
    /^package\.json script "test" runs ajs module test with its own --timeout 10000/m;

  const check = bin(root, "sync", ["--check"]);
  assert.equal(check.status, 1, check.stdout);
  assert.match(check.stderr, finding);

  const write = bin(root, "sync");
  assert.equal(write.status, 0, write.stderr);
  assert.equal(
    parseManifest(read(root, "package.json")).scripts?.test,
    "ajs module test . --timeout 30000",
  );
  assert.equal(
    parseManifest(read(root, "packages/member/package.json")).scripts?.test,
    "pnpm run build && ajs module test . --timeout 30000",
  );
  assert.doesNotMatch(write.stdout, finding);
  assert.match(
    write.stdout,
    /^Note: package\.json script "log" runs mocha with its own --timeout 10000/m,
  );
});

function withCore(root: string, spec: string): void {
  const manifest = parseManifest(read(root, "package.json"));
  manifest.devDependencies = {
    ...manifest.devDependencies,
    "@antelopejs/core": spec,
  };
  put(root, "package.json", `${JSON.stringify(manifest, null, 2)}\n`);
}

test("auth-jwt: sync fails and writes nothing while a manifest running ajs module test lets @antelopejs/core resolve to 1.23.0, which rejects --timeout, naming the manifest, the range and the fix, where a sync that only adds the flag breaks the test script", (t) => {
  const root = testRepo(t);
  assert.equal(bin(root, "sync").status, 0);
  put(root, "pnpm-workspace.yaml", "packages:\n  - packages/*\n");
  withCore(root, "^1.23.0");
  withScripts(root, { test: "ajs module test ." });
  withScripts(
    root,
    { test: "pnpm run build && ajs module test ." },
    "packages/member/package.json",
  );
  commit(root);
  const before = read(root, "package.json");

  for (const args of [["--check"], []]) {
    const result = bin(root, "sync", args);
    assert.equal(result.status, 1, result.stdout);
    for (const path of ["package.json", "packages/member/package.json"])
      assert.ok(
        result.stderr.includes(
          `${path} runs ajs module test, which sync gives --timeout 30000, and "@antelopejs/core" "^1.23.0" admits 1.23.0, whose ajs module test rejects --timeout. Set "@antelopejs/core" to ">=1.23.1" or later, run \`pnpm install\`, then run antelopejs-sync.`,
        ),
        result.stderr,
      );
  }
  assert.equal(read(root, "package.json"), before);
});

test("a core range from 1.23.1, a non-semver core spec or a repository running only mocha passes and gets the shared timeout, where a check that flags every declared core fails them", (t) => {
  for (const [spec, script] of [
    ["^1.23.1", "ajs module test ."],
    ["workspace:*", "ajs module test ."],
    ["1.23.0", "mocha"],
  ]) {
    const root = testRepo(t);
    assert.equal(bin(root, "sync").status, 0);
    withCore(root, spec);
    withScripts(root, { test: script });
    commit(root);
    const write = bin(root, "sync");
    assert.equal(write.status, 0, write.stderr);
    assert.equal(
      parseManifest(read(root, "package.json")).scripts?.test,
      `${script} --timeout 30000`,
    );
  }
});
