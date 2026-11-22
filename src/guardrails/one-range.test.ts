import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import { bin, commit, put, testRepo } from "./helpers/test-repo.ts";
import { checkOneRange } from "./one-range.ts";

const PASSING_STEPS = [
  "typecheck",
  "lint",
  "format:check",
  "knip",
  "test",
  "size",
  "suppressions",
  "sync:check",
];

const SDK = "@antelopejs/tooling-configs";

/** A committed repository whose root, `cli/` and `sdk/` manifests declare `@antelopejs/tooling-configs` on the given ranges. */
function repoWithRanges(
  t: TestContext,
  [rootRange, cliRange, sdkRange]: readonly [string, string, string],
  files: Readonly<Record<string, string>> = {},
): string {
  const root = testRepo(t);
  put(
    root,
    "package.json",
    JSON.stringify({
      packageManager: "pnpm@10.2.0",
      scripts: Object.fromEntries(
        PASSING_STEPS.map((name) => [name, 'node -e "process.exit(0)"']),
      ),
      devDependencies: { [SDK]: rootRange },
    }),
  );
  put(
    root,
    "cli/package.json",
    JSON.stringify({ devDependencies: { [SDK]: cliRange } }),
  );
  put(
    root,
    "sdk/package.json",
    JSON.stringify({ dependencies: { [SDK]: sdkRange } }),
  );
  for (const [path, content] of Object.entries(files)) put(root, path, content);
  commit(root);
  return root;
}

test("two ranges on one package across manifests fail checks naming each range and its files, where a run without dependency:one-range passes the repository whose lockfile holds two copies", (t) => {
  const root = repoWithRanges(t, [
    ">=0.9.4 <0.10.0",
    ">=0.9.3 <0.10.0",
    ">=0.9.3 <0.10.0",
  ]);
  const result = bin(root, "checks", [], { ANTELOPEJS_CI_TIER: "fast" });
  assert.equal(result.status, 1, result.stdout);
  assert.match(
    result.stdout,
    /\[dependency:one-range\]\n"@antelopejs\/tooling-configs" is declared with 2 ranges, .*:\n {2}">=0\.9\.3 <0\.10\.0" in cli\/package\.json, sdk\/package\.json\n {2}">=0\.9\.4 <0\.10\.0" in package\.json\n/,
  );
});

test("one range in every manifest passes, where a check that compares fields or files instead of specs fails a repository that locks one copy", (t) => {
  const range = ">=0.9.4 <0.10.0";
  assert.equal(checkOneRange(repoWithRanges(t, [range, range, range])), "");
});

test("workspace, file and link specs and peer ranges pass beside a release range, where a check reading every spec fails siblings that install no second release", (t) => {
  const range = ">=0.9.4 <0.10.0";
  const root = repoWithRanges(t, [range, "workspace:~", "file:../sdk"], {
    "e2e/package.json": JSON.stringify({
      devDependencies: { [SDK]: "link:.." },
      peerDependencies: { [SDK]: ">=0.9.0 <0.10.0" },
    }),
  });
  assert.equal(checkOneRange(root), "");
});

test("a package listed under exceptions in guardrails.one-range.json passes with two ranges, where a check without the exception list fails a deliberate split", (t) => {
  const root = repoWithRanges(
    t,
    [">=0.9.4 <0.10.0", ">=0.8.0 <0.9.0", ">=0.9.4 <0.10.0"],
    { "guardrails.one-range.json": JSON.stringify({ exceptions: [SDK] }) },
  );
  assert.equal(checkOneRange(root), "");
});

test("a malformed guardrails.one-range.json fails with the shape it expects, where a check that ignores it silently passes every split", (t) => {
  const range = ">=0.9.4 <0.10.0";
  const root = repoWithRanges(t, [range, range, range], {
    "guardrails.one-range.json": JSON.stringify({ exceptions: "all" }),
  });
  assert.equal(
    checkOneRange(root),
    'guardrails.one-range.json: expected { "exceptions": ["@antelopejs/<name>"] }.\n',
  );
});
