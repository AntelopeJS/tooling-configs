import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { formatCeilings } from "./ceilings.ts";
import {
  bin,
  commit,
  linkOxlint,
  PACKAGE_ROOT,
  put,
  testRepo,
} from "./helpers/test-repo.ts";

const SAFETY = "anti-slop/require-safety-comment-for-type-assertion";
const UNKNOWN_RETURNS = "anti-slop/no-unknown-returns";

const POSTGRES_33_BASE =
  "export async function Refusal(work: () => PromiseLike<unknown>): Promise<string> {\n  return String(await work());\n}\n";
const POSTGRES_33_BRANCH =
  "export async function Refusal(work: () => PromiseLike<string>): Promise<string> {\n  return String(await work());\n}\n";

const MOLLIE_5_PRELUDE =
  "interface Own {\n  id: string;\n}\ndeclare function readOwn(record: object): object | undefined;\ndeclare function ownOf(record: object): Own;\n";
const MOLLIE_5_BASE = `${MOLLIE_5_PRELUDE}export function settle(mollie: object): Own {\n  const own = readOwn(mollie) as Own;\n  return own;\n}\n`;
const MOLLIE_5_BRANCH = `${MOLLIE_5_PRELUDE}export function settle(mollie: object): Own {\n  const own = ownOf(mollie);\n  return own;\n}\n`;
const FALSE_SAFETY = `${MOLLIE_5_PRELUDE}export function settle(mollie: object): Own {\n  // SAFETY: readOwn always finds the record's own metadata.\n  const own = readOwn(mollie) as Own;\n  return own;\n}\n`;

function stage(root: string, ...files: string[]): void {
  execFileSync("git", ["add", "-A", "--", ...files], { cwd: root });
}

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function baseRepo(t: TestContext, files: Record<string, string>): string {
  const root = testRepo(t);
  linkOxlint(root);
  put(
    root,
    ".oxlintrc.json",
    JSON.stringify({
      categories: { correctness: "off" },
      jsPlugins: [
        {
          name: "anti-slop",
          specifier: join(PACKAGE_ROOT, "src/oxc/anti-slop/index.ts"),
        },
      ],
      rules: { [SAFETY]: "error", [UNKNOWN_RETURNS]: "error" },
    }),
  );
  put(
    root,
    "guardrails.ratchet.json",
    formatCeilings({
      rules: { [SAFETY]: 5, [UNKNOWN_RETURNS]: 5 },
      oversizeFiles: {},
    }),
  );
  for (const [file, content] of Object.entries(files)) put(root, file, content);
  commit(root);
  git(root, "update-ref", "refs/remotes/origin/main", "HEAD");
  git(
    root,
    "symbolic-ref",
    "refs/remotes/origin/HEAD",
    "refs/remotes/origin/main",
  );
  return root;
}

function branchRepo(
  t: TestContext,
  file: string,
  base: string,
  branch: string,
): string {
  const root = baseRepo(t, { [file]: base });
  put(root, file, branch);
  commit(root);
  return root;
}

function check(root: string, ...files: string[]) {
  return bin(root, "ratchet", ["--staged", ...files]);
}

test("staged ratchet passes a restore of the base line the branch rewrote (postgres #33 refusals.test.ts:12)", (t) => {
  const root = branchRepo(
    t,
    "refusals.test.ts",
    POSTGRES_33_BASE,
    POSTGRES_33_BRANCH,
  );
  put(root, "refusals.test.ts", POSTGRES_33_BASE);
  stage(root, "refusals.test.ts");
  const result = check(root, "refusals.test.ts");
  assert.equal(result.status, 0, result.stderr);
});

test("staged ratchet passes a restore of the base assertion the branch replaced (mollie #5 creation.ts:282)", (t) => {
  const root = branchRepo(t, "creation.ts", MOLLIE_5_BASE, MOLLIE_5_BRANCH);
  put(root, "creation.ts", MOLLIE_5_BASE);
  stage(root, "creation.ts");
  const result = check(root, "creation.ts");
  assert.equal(result.status, 0, result.stderr);
});

test("staged ratchet passes removing a false SAFETY comment the branch added", (t) => {
  const root = branchRepo(t, "creation.ts", MOLLIE_5_BASE, FALSE_SAFETY);
  put(root, "creation.ts", MOLLIE_5_BASE);
  stage(root, "creation.ts");
  const result = check(root, "creation.ts");
  assert.equal(result.status, 0, result.stderr);
});

test("staged ratchet follows a rename the branch made from the base", (t) => {
  const root = branchRepo(t, "creation.ts", MOLLIE_5_BASE, MOLLIE_5_BRANCH);
  git(root, "mv", "creation.ts", "settle.ts");
  commit(root);
  put(root, "settle.ts", MOLLIE_5_BASE);
  stage(root, "settle.ts");
  const result = check(root, "settle.ts");
  assert.equal(result.status, 0, result.stderr);
});

test("staged ratchet fails a finding the base does not have and lists only it", (t) => {
  const root = branchRepo(t, "creation.ts", MOLLIE_5_BASE, MOLLIE_5_BRANCH);
  put(
    root,
    "creation.ts",
    MOLLIE_5_BASE.replace(
      "  return own;\n",
      "  const again = readOwn(mollie) as Own;\n  return again ?? own;\n",
    ),
  );
  stage(root, "creation.ts");
  const result = check(root, "creation.ts");
  assert.equal(result.status, 1);
  const base = git(root, "rev-parse", "--short=12", "origin/main");
  assert.match(
    result.stderr,
    new RegExp(
      `${SAFETY}: this commit adds 1 to the staged files \\(0 at HEAD, 1 unchanged since merge-base ${base} with origin/HEAD, 2 staged\\)`,
    ),
  );
  assert.match(result.stderr, /creation\.ts:8:/);
  assert.doesNotMatch(result.stderr, /creation\.ts:7:/);
});

test("staged ratchet compares with HEAD and says so when no base resolves", (t) => {
  const root = branchRepo(t, "creation.ts", MOLLIE_5_BASE, MOLLIE_5_BRANCH);
  git(root, "symbolic-ref", "--delete", "refs/remotes/origin/HEAD");
  put(root, "creation.ts", MOLLIE_5_BASE);
  stage(root, "creation.ts");
  const result = check(root, "creation.ts");
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /this commit adds 1 to the staged files \(0 at HEAD, 1 staged\)/,
  );
  assert.match(
    result.stderr,
    /No pull request base resolved \(GITHUB_BASE_REF or origin\/HEAD\), so this compared with HEAD/,
  );
});

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
