import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { formatBudget } from "./suppression-budget.ts";
import { syncRepository } from "./sync.ts";
import { bin, commit, put, read, testRepo } from "./helpers/test-repo.ts";

const FIX =
  /Fix: fix the code, or remove another suppression of the same kind; a rule that keeps needing suppressions should be changed in the preset\./;

const ROUTES = [
  "// oxlint-disable-next-line eslint/max-params",
  "export function route(a, b, c, d, e, f) {}",
  "// oxlint-disable-next-line eslint/max-params",
  "export function realtime(a, b, c, d, e, f) {}",
  "// @ts-expect-error a progress needs its total",
  "export const progress: number = 'total';",
  "",
].join("\n");

function budgetRepo(t: Parameters<typeof testRepo>[0]): string {
  const root = testRepo(t);
  put(root, "src/routes.ts", ROUTES);
  put(
    root,
    "guardrails.suppressions.json",
    formatBudget({
      rules: { "eslint/max-params": 2 },
      tsExpectError: 1,
      tsIgnore: 0,
      safety: 0,
    }),
  );
  commit(root);
  return root;
}

function git(root: string, args: string[]): void {
  execFileSync("git", args, { cwd: root });
}

test("a suppression over its ceiling fails with its file:line and the fix; removing one passes quietly and --update lowers without ever raising", (t) => {
  const root = budgetRepo(t);
  const clean = bin(root, "suppressions");
  assert.equal(clean.status, 0);
  assert.equal(clean.stdout + clean.stderr, "");
  put(
    root,
    "src/realtime.ts",
    "export const bound = (a, b, c, d, e, f) => a; // oxlint-disable-line eslint/max-params -- six realtime handles\n",
  );
  const added = bin(root, "suppressions");
  assert.equal(added.status, 1);
  assert.match(
    added.stderr,
    /lint rule `eslint\/max-params`: 3 exceeds ceiling 2\.\n {2}src\/realtime\.ts:1\n {2}\.\.\.and 2 in files this change does not touch\./,
  );
  assert.match(added.stderr, FIX);
  rmSync(join(root, "src/realtime.ts"));
  put(root, "src/routes.ts", ROUTES.split("\n").slice(2).join("\n"));
  assert.equal(bin(root, "suppressions").status, 0);
  assert.equal(bin(root, "suppressions", ["--update"]).status, 0);
  assert.deepEqual(JSON.parse(read(root, "guardrails.suppressions.json")), {
    rules: { "eslint/max-params": 1 },
    tsExpectError: 1,
    tsIgnore: 0,
    safety: 0,
  });
  put(root, "src/routes.ts", ROUTES);
  const update = bin(root, "suppressions", ["--update"]);
  assert.equal(update.status, 1);
  assert.equal(
    JSON.parse(read(root, "guardrails.suppressions.json")).rules[
      "eslint/max-params"
    ],
    1,
  );
});

test("renaming a file keeps its suppressions in the staged and the full check", (t) => {
  const root = budgetRepo(t);
  git(root, ["mv", "src/routes.ts", "src/router.ts"]);
  const staged = bin(root, "suppressions", ["--staged"]);
  assert.equal(staged.status, 0, staged.stderr);
  assert.equal(bin(root, "suppressions").status, 0);
});

test("the staged check fails a commit adding an inline directive, nets a suppression moved between staged files, and honours a raise made by hand", (t) => {
  const root = budgetRepo(t);
  put(
    root,
    "src/routes.ts",
    `${ROUTES}export const debug = () => console.log("route"); // oxlint-disable-line no-console -- prints each matched route while debugging\n`,
  );
  git(root, ["add", "src/routes.ts"]);
  const inline = bin(root, "suppressions", ["--staged"]);
  assert.equal(inline.status, 1);
  assert.match(
    inline.stderr,
    /lint rule `no-console`: this commit adds 1 to the staged files\.\n {2}src\/routes\.ts:7\n/,
  );
  assert.match(inline.stderr, FIX);
  put(
    root,
    "guardrails.suppressions.json",
    formatBudget({
      rules: { "eslint/max-params": 2, "no-console": 1 },
      tsExpectError: 1,
      tsIgnore: 0,
      safety: 0,
    }),
  );
  git(root, ["add", "guardrails.suppressions.json"]);
  assert.equal(bin(root, "suppressions", ["--staged"]).status, 0);
  git(root, ["reset", "-q", "--hard"]);
  const [first, , ...rest] = ROUTES.split("\n");
  put(root, "src/routes.ts", rest.join("\n"));
  put(
    root,
    "src/route.ts",
    `${first}\nexport function route(a, b, c, d, e, f) {}\n`,
  );
  git(root, ["add", "src"]);
  assert.equal(bin(root, "suppressions", ["--staged"]).status, 0);
});

test("sync writes the current counts once, never rewrites the budget, restores a deleted one from HEAD, and the template profile writes none", (t) => {
  const root = testRepo(t);
  put(root, "src/routes.ts", ROUTES);
  put(
    root,
    "src/cast.ts",
    "// SAFETY: a route id is a string\nexport const id = (1 as unknown) as string;\n",
  );
  assert.equal(
    syncRepository(root, { profile: "template" }).paths.includes(
      "guardrails.suppressions.json",
    ),
    false,
  );
  const adoption = syncRepository(root, { check: true });
  assert.ok(adoption.paths.includes("guardrails.suppressions.json"));
  put(
    root,
    "package.json",
    '{\n  "name": "budget", "scripts": { "sync:check": "x" }\n}\n',
  );
  syncRepository(root);
  const adopted = {
    rules: { "eslint/max-params": 2 },
    tsExpectError: 1,
    tsIgnore: 0,
    safety: 1,
    config: {},
  };
  assert.deepEqual(
    JSON.parse(read(root, "guardrails.suppressions.json")),
    adopted,
  );
  commit(root);
  put(
    root,
    "src/more.ts",
    "// @ts-expect-error a third\nexport const more: number = '';\n",
  );
  rmSync(join(root, "guardrails.suppressions.json"));
  syncRepository(root);
  assert.deepEqual(
    JSON.parse(read(root, "guardrails.suppressions.json")),
    adopted,
  );
  assert.equal(bin(root, "suppressions").status, 1);
});
