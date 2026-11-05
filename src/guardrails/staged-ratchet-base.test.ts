import assert from "node:assert/strict";
import test from "node:test";

import {
  branchRepo,
  check,
  MOLLIE_5_BASE,
  MOLLIE_5_BRANCH,
  MOLLIE_5_PRELUDE,
  SAFETY,
  git,
  stage,
} from "./helpers/staged-ratchet-repo.ts";
import { commit, put } from "./helpers/test-repo.ts";

const POSTGRES_33_BASE =
  "export async function Refusal(work: () => PromiseLike<unknown>): Promise<string> {\n  return String(await work());\n}\n";
const POSTGRES_33_BRANCH =
  "export async function Refusal(work: () => PromiseLike<string>): Promise<string> {\n  return String(await work());\n}\n";
const FALSE_SAFETY = `${MOLLIE_5_PRELUDE}export function settle(mollie: object): Own {\n  // SAFETY: readOwn always finds the record's own metadata.\n  const own = readOwn(mollie) as Own;\n  return own;\n}\n`;

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
