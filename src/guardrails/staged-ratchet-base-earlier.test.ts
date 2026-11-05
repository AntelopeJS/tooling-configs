import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import {
  ANNOTATED,
  baseRepo,
  branchRepo,
  CAST,
  check,
  git,
  MOLLIE_5_BASE,
  MOLLIE_5_BRANCH,
  MOLLIE_5_PRELUDE,
  stage,
} from "./helpers/staged-ratchet-repo.ts";
import { commit, put } from "./helpers/test-repo.ts";

const SETTLE =
  "export function settle(mollie: object): Own {\n  return readOwn(mollie) as Own;\n}\n";
const MOVE_SOURCE = `${MOLLIE_5_PRELUDE}export const x = 1;\n${SETTLE}`;
const MOVE_TARGET = `${MOLLIE_5_PRELUDE}export const y = 1;\n`;

function movedRepo(t: TestContext): string {
  const root = baseRepo(t, { "x.ts": MOVE_SOURCE, "y.ts": MOVE_TARGET });
  put(root, "x.ts", `${MOLLIE_5_PRELUDE}export const x = 1;\n`);
  put(root, "y.ts", `${MOVE_TARGET}${SETTLE}`);
  stage(root, "x.ts", "y.ts");
  const move = check(root, "x.ts", "y.ts");
  assert.equal(move.status, 0, move.stderr);
  commit(root);
  return root;
}

test("staged ratchet passes an edit of a file a legacy finding moved into in an earlier branch commit", (t) => {
  const root = movedRepo(t);
  put(root, "y.ts", `${MOVE_TARGET.replace("y = 1", "y = 2")}${SETTLE}`);
  stage(root, "y.ts");
  const edit = check(root, "y.ts");
  assert.equal(edit.status, 0, edit.stderr);
  put(
    root,
    "y.ts",
    `${MOVE_TARGET}${SETTLE}export const extra = readOwn({}) as Own;\n`,
  );
  stage(root, "y.ts");
  const added = check(root, "y.ts");
  assert.equal(added.status, 1);
  const base = git(root, "rev-parse", "--short=12", "origin/main");
  assert.match(
    added.stderr,
    new RegExp(
      `adds 1 to the staged files \\(1 at HEAD, 0 unchanged since merge-base ${base} with origin/HEAD, 2 staged\\)`,
    ),
  );
  assert.match(added.stderr, /y\.ts:10:/);
  assert.doesNotMatch(added.stderr, /y\.ts:8:/);
});

test("staged ratchet passes a stacked branch editing a file its parent branch moved a legacy finding into", (t) => {
  const root = movedRepo(t);
  git(root, "update-ref", "refs/remotes/origin/feature-a", "HEAD");
  git(root, "checkout", "-q", "-b", "feature-b");
  put(root, "z.ts", "export const z = 1;\n");
  commit(root);
  put(root, "y.ts", `${MOVE_TARGET.replace("y = 1", "y = 2")}${SETTLE}`);
  stage(root, "y.ts");
  const result = check(root, "y.ts");
  assert.equal(result.status, 0, result.stderr);
});

test("staged ratchet fails a finding added to a file a legacy finding moved out of in an earlier branch commit", (t) => {
  const root = movedRepo(t);
  put(
    root,
    "x.ts",
    `${MOLLIE_5_PRELUDE}export const x = 1;\nexport const extra = readOwn({}) as Own;\n`,
  );
  stage(root, "x.ts");
  const result = check(root, "x.ts");
  assert.equal(result.status, 1);
  const base = git(root, "rev-parse", "--short=12", "origin/main");
  assert.match(
    result.stderr,
    new RegExp(
      `adds 1 to the staged files \\(0 at HEAD, 0 unchanged since merge-base ${base} with origin/HEAD, 1 staged\\)`,
    ),
  );
  assert.match(result.stderr, /x\.ts:7:/);
});

test("staged ratchet fails a new finding in a file whose base finding the branch fixed earlier", (t) => {
  const root = branchRepo(t, "creation.ts", MOLLIE_5_BASE, MOLLIE_5_BRANCH);
  put(
    root,
    "creation.ts",
    MOLLIE_5_BRANCH.replace(
      "  return own;\n",
      "  return (readOwn(own) as Own) ?? own;\n",
    ),
  );
  stage(root, "creation.ts");
  const result = check(root, "creation.ts");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /creation\.ts:8:/);
});

test("staged ratchet fails a new finding in another file staged with the file whose base finding the branch fixed", (t) => {
  const root = baseRepo(t, {
    "creation.ts": MOLLIE_5_BASE,
    "y.ts": MOVE_TARGET,
  });
  put(root, "creation.ts", MOLLIE_5_BRANCH);
  commit(root);
  put(
    root,
    "creation.ts",
    MOLLIE_5_BRANCH.replace("own;\n}", "own;\n}\nexport const z = 1;"),
  );
  put(root, "y.ts", `${MOVE_TARGET}export const extra = readOwn({}) as Own;\n`);
  stage(root, "creation.ts", "y.ts");
  const result = check(root, "creation.ts", "y.ts");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /y\.ts:7:/);
});

const CALL = "export const b = readOwn(\n  {},\n);\n";
const CALL_CAST = "export const b = readOwn(\n  {},\n) as Own;\n";

function movedOut(t: TestContext, rest: string): string {
  const root = baseRepo(t, {
    "x.ts": `${MOLLIE_5_PRELUDE}${CAST("a")}${rest}`,
    "y.ts": MOLLIE_5_PRELUDE,
  });
  put(root, "x.ts", `${MOLLIE_5_PRELUDE}${rest}`);
  put(root, "y.ts", `${MOLLIE_5_PRELUDE}${CAST("a")}`);
  stage(root, "x.ts", "y.ts");
  const move = check(root, "x.ts", "y.ts");
  assert.equal(move.status, 0, move.stderr);
  commit(root);
  return root;
}

function fixedEarlier(t: TestContext, rest: string): string {
  return branchRepo(
    t,
    "x.ts",
    `${MOLLIE_5_PRELUDE}${CAST("a")}${rest}`,
    `${MOLLIE_5_PRELUDE}${rest}`,
  );
}

for (const [label, setup] of [
  ["moved a legacy finding out of the file", movedOut],
  ["fixed a base finding in the file", fixedEarlier],
] as const) {
  test(`staged ratchet fails a cast added at the end of a multi-line call after the branch ${label}`, (t) => {
    const root = setup(t, CALL);
    put(root, "x.ts", `${MOLLIE_5_PRELUDE}${CALL_CAST}`);
    stage(root, "x.ts");
    const result = check(root, "x.ts");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /adds 1 to the staged files/);
  });

  test(`staged ratchet fails removing a base SAFETY comment after the branch ${label}`, (t) => {
    const root = setup(t, ANNOTATED("c"));
    put(root, "x.ts", `${MOLLIE_5_PRELUDE}${CAST("c")}`);
    stage(root, "x.ts");
    const result = check(root, "x.ts");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /adds 1 to the staged files/);
  });
}
