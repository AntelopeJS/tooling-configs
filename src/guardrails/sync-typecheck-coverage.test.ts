import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import { parseManifest } from "./package.ts";
import { findingsFor } from "./helpers/coverage-repo.ts";
import { bin, commit, put, read, testRepo } from "./helpers/test-repo.ts";

const FULL = { typecheck: "tsc --noEmit" };

test("a build that skips the lib check over the program typecheck covers passes, whichever way the program is spelled; comparing the raw -p strings fails the equal spellings", (t) => {
  for (const [build, typecheck] of [
    ["rimraf dist && tsc --skipLibCheck", "tsc --noEmit"],
    ["tsc -p tsconfig.json --skipLibCheck", "tsc --noEmit"],
    ["tsc --skipLibCheck --project ./tsconfig.json", "tsc --noEmit"],
    [
      "tsc --skipLibCheck -p ./tsconfig.build.json",
      "tsc --noEmit -p tsconfig.build.json",
    ],
    ["tsc --skipLibCheck -p .", "tsc --noEmit"],
    ["tsc --skipLibCheck -p src", "tsc --noEmit -p src/tsconfig.json"],
    ["NODE_ENV=production pnpm exec tsc --skipLibCheck", "npx tsc --noEmit"],
  ])
    assert.deepEqual(findingsFor(t, { build, typecheck }), [], build);
});

test("a build that skips the lib check over another program than typecheck fails, naming package.json, the script and the fix; a check that ignores -p passes it", (t) => {
  const errors = findingsFor(t, {
    build: "rimraf dist && tsc --skipLibCheck -p tsconfig.build.json",
    ...FULL,
  });
  assert.equal(errors.length, 1);
  assert.match(
    errors[0],
    /^package\.json: script "build" passes --skipLibCheck/,
  );
  assert.match(errors[0], /tsconfig\.build\.json/);
  assert.match(
    errors[0],
    /Make "typecheck" run `tsc --noEmit -p tsconfig\.build\.json`/,
  );
});

test("a typecheck that is absent or itself passes --skipLibCheck covers nothing; a check that counts any typecheck run passes both", (t) => {
  const absent = findingsFor(t, { build: "tsc --skipLibCheck" });
  assert.match(absent.join("\n"), /there is no "typecheck" script/);
  const skipping = findingsFor(t, {
    build: "tsc --skipLibCheck",
    typecheck: "tsc --noEmit --skipLibCheck",
  });
  assert.match(
    skipping.join("\n"),
    /script "typecheck" also passes --skipLibCheck/,
  );
});

test("a typecheck over several programs covers a build over any one of them; a check that reads only its first tsc run fails the second", (t) => {
  assert.deepEqual(
    findingsFor(t, {
      build: "rimraf dist && tsc --skipLibCheck -p test",
      typecheck: "tsc --noEmit && tsc --noEmit -p test",
    }),
    [],
  );
});

test("a build without --skipLibCheck, or with it switched off, asks nothing of typecheck; a check that flags the bare flag name fails them", (t) => {
  assert.deepEqual(findingsFor(t, { build: "tsc" }), []);
  assert.deepEqual(findingsFor(t, { build: "tsc --skipLibCheck false" }), []);
});

test("the tsc a build reaches through another script counts; a check that reads only the build script's own text passes the skipped program", (t) => {
  const errors = findingsFor(t, {
    build: "rimraf dist && pnpm run compile",
    compile: "tsc --skipLibCheck -p tsconfig.build.json",
    ...FULL,
  });
  assert.match(
    errors.join("\n"),
    /script "build" passes --skipLibCheck to tsc for tsconfig\.build\.json/,
  );
});

test("skipLibCheck: true in the root tsconfig fails, naming the file and the script that reads it, even behind comments; a check that parses with JSON.parse or reads only package.json passes it", (t) => {
  const errors = findingsFor(
    t,
    { build: "tsc", ...FULL },
    {
      "tsconfig.json": `{\n  // keep the lib check\n  "compilerOptions": { "strict": true, "skipLibCheck": true, },\n}\n`,
    },
  );
  assert.equal(errors.length, 1);
  assert.match(
    errors[0],
    /^tsconfig\.json: sets compilerOptions\.skipLibCheck: true, read by tsconfig\.json \(script "build", "typecheck"\)\./,
  );
  assert.match(errors[0], /Remove it/);
});

test("a tsconfig only a script reads through -p is checked too; a check of the root tsconfig.json alone passes it", (t) => {
  const errors = findingsFor(
    t,
    { build: "tsc --skipLibCheck -p tsconfig.build.json", ...FULL },
    {
      "tsconfig.json": "{}",
      "tsconfig.build.json": '{ "compilerOptions": { "skipLibCheck": true } }',
    },
  );
  assert.match(
    errors.join("\n"),
    /^tsconfig\.build\.json: sets compilerOptions\.skipLibCheck: true, read by tsconfig\.build\.json \(script "build"\)/m,
  );
});

test("a tsconfig no script uses and the root does not extend is left alone; a check that scans every tsconfig*.json fails it", (t) => {
  assert.deepEqual(
    findingsFor(
      t,
      { build: "tsc", ...FULL },
      {
        "tsconfig.json": "{}",
        "tsconfig.spec.json": '{ "compilerOptions": { "skipLibCheck": true } }',
      },
    ),
    [],
  );
});

test("skipLibCheck set by a local extends chain is found and the error names the file that sets it; a check of the file's own options passes it", (t) => {
  for (const extended of [
    '"./base"',
    '"./base.json"',
    '["./other.json", "./base"]',
  ])
    assert.match(
      findingsFor(t, FULL, {
        "tsconfig.json": `{ "extends": ${extended} }`,
        "base.json": '{ "compilerOptions": { "skipLibCheck": true } }',
        "other.json": "{}",
      }).join("\n"),
      /^base\.json: sets compilerOptions\.skipLibCheck: true, read by tsconfig\.json \(script "typecheck"\)/,
      extended,
    );
});

test("a config that switches skipLibCheck off over an extended one passes, a later extends entry wins, and a cycle ends; a check that flags any true in the chain fails the first two and one without a visited set never ends", (t) => {
  assert.deepEqual(
    findingsFor(t, FULL, {
      "tsconfig.json":
        '{ "extends": "./base.json", "compilerOptions": { "skipLibCheck": false } }',
      "base.json": '{ "compilerOptions": { "skipLibCheck": true } }',
    }),
    [],
  );
  assert.deepEqual(
    findingsFor(t, FULL, {
      "tsconfig.json": '{ "extends": ["./base.json", "./off.json"] }',
      "base.json": '{ "compilerOptions": { "skipLibCheck": true } }',
      "off.json": '{ "compilerOptions": { "skipLibCheck": false } }',
    }),
    [],
  );
  assert.deepEqual(
    findingsFor(t, FULL, {
      "tsconfig.json": '{ "extends": "./base.json" }',
      "base.json": '{ "extends": "./tsconfig.json" }',
    }),
    [],
  );
});

test("a package preset the tsconfig extends is not read; a check that resolves node_modules presets fails a repository whose preset sets the flag", (t) => {
  assert.deepEqual(
    findingsFor(t, FULL, {
      "tsconfig.json": '{ "extends": "@tsconfig/node20/tsconfig.json" }',
      "node_modules/@tsconfig/node20/tsconfig.json":
        '{ "compilerOptions": { "skipLibCheck": true } }',
    }),
    [],
  );
});

test("a release that does not run typecheck fails, naming the script and the fix; a check that never reads release passes it, and one that looks for the word typecheck passes typecheck:watch", (t) => {
  for (const release of [
    "pnpm run lint && release-it",
    "pnpm run lint && pnpm run typecheck:watch && release-it",
    "npm typecheck && release-it",
    "echo typecheck && release-it",
  ]) {
    const errors = findingsFor(t, {
      release,
      "typecheck:watch": "tsc --noEmit -w",
      ...FULL,
    });
    assert.equal(errors.length, 1, release);
    assert.match(
      errors[0],
      /^package\.json: script "release" does not run "typecheck"/,
    );
    assert.match(errors[0], /Add `pnpm run typecheck` to "release"/);
  }
  assert.deepEqual(findingsFor(t, { ...FULL }), []);
});

test("a release that runs typecheck directly passes with each package manager's spelling; a check that knows only `pnpm run typecheck` fails the others", (t) => {
  for (const run of [
    "pnpm run typecheck",
    "pnpm typecheck",
    "npm run typecheck",
    "yarn typecheck",
    "bun run typecheck",
    "pnpm run typecheck -- --pretty",
  ])
    assert.deepEqual(
      findingsFor(t, {
        release: `pnpm run lint && ${run} && release-it`,
        ...FULL,
      }),
      [],
      run,
    );
});

test("a release reaches typecheck through the scripts it runs, to a bounded depth; a check that reads only release's own text fails the indirect run, and one that follows scripts without a bound never ends on a cycle", (t) => {
  assert.deepEqual(
    findingsFor(t, {
      release: "pnpm run verify && release-it",
      verify: "pnpm run lint && pnpm run prepack",
      prepack: "pnpm run typecheck && pnpm run build",
      build: "tsc",
      ...FULL,
    }),
    [],
  );
  assert.equal(
    findingsFor(t, {
      release: "pnpm run prepack",
      prepack: "pnpm run release",
      ...FULL,
    }).length,
    1,
  );
  const chain = Object.fromEntries(
    Array.from({ length: 8 }, (_, step) => [
      `hop${step}`,
      step === 7 ? "pnpm run typecheck" : `pnpm run hop${step + 1}`,
    ]),
  );
  assert.equal(
    findingsFor(t, { release: "pnpm run hop0", ...chain, ...FULL }).length,
    1,
  );
});

function syncedRepo(t: TestContext): string {
  const root = testRepo(t);
  put(
    root,
    "guardrails.ratchet.json",
    '{"rules":{"eslint/no-alert":1},"oversizeFiles":{}}\n',
  );
  const result = bin(root, "sync");
  assert.equal(result.status, 0, result.stderr);
  commit(root);
  return root;
}

function withScripts(root: string, scripts: Record<string, string>): void {
  const manifest = parseManifest(read(root, "package.json"));
  manifest.scripts = { ...manifest.scripts, ...scripts };
  put(root, "package.json", `${JSON.stringify(manifest, null, 2)}\n`);
}

test("sync --check fails on each finding, printed on stderr, and a write run prints it as a Note and exits 0; a check that keeps --check report-only passes the repository, and one that fails the write run blocks it from syncing", (t) => {
  const root = syncedRepo(t);
  const clean = bin(root, "sync", ["--check"]);
  assert.equal(clean.status, 0, clean.stderr);
  assert.doesNotMatch(clean.stdout, /skipLibCheck|typecheck/);

  withScripts(root, {
    build: "rimraf dist && tsc --skipLibCheck -p tsconfig.build.json",
    release: "pnpm run lint && release-it",
  });
  put(root, "tsconfig.json", '{ "compilerOptions": { "skipLibCheck": true } }');
  const findings = [
    /package\.json: script "build" passes --skipLibCheck/,
    /tsconfig\.json: sets compilerOptions\.skipLibCheck: true/,
    /package\.json: script "release" does not run "typecheck"/,
  ];
  const check = bin(root, "sync", ["--check"]);
  assert.equal(check.status, 1, check.stdout);
  assert.doesNotMatch(check.stdout, /skipLibCheck|typecheck/);
  for (const finding of findings)
    assert.match(check.stderr, new RegExp(`^${finding.source}`, "m"));

  const write = bin(root, "sync");
  assert.equal(write.status, 0, write.stderr);
  assert.doesNotMatch(write.stderr, /skipLibCheck|typecheck/);
  for (const finding of findings)
    assert.match(write.stdout, new RegExp(`^Note: ${finding.source}`, "m"));
});
