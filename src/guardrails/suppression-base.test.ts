import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { formatBudget } from "./suppression-budget.ts";
import { bin, commit, linkOxlint, put, testRepo } from "./helpers/test-repo.ts";

const DIRECTIVE = "// oxlint-disable-next-line eslint/max-params\n";

function budget(maxParams: number | undefined): string {
  return formatBudget({
    rules: maxParams === undefined ? {} : { "eslint/max-params": maxParams },
    tsExpectError: 0,
    tsIgnore: 0,
    safety: 0,
  });
}

function git(root: string, args: string[]): void {
  execFileSync("git", args, { cwd: root, stdio: "pipe" });
}

test("a ceiling raised or removed by hand fails against the base even within the budget, and a lowered one passes", (t) => {
  const root = testRepo(t);
  linkOxlint(root);
  put(root, "src/a.ts", DIRECTIVE.repeat(2));
  put(root, "guardrails.suppressions.json", budget(2));
  commit(root);
  put(root, "src/a.ts", DIRECTIVE.repeat(3));
  put(root, "guardrails.suppressions.json", budget(3));
  commit(root);
  assert.equal(bin(root, "suppressions").status, 0);
  const raised = bin(root, "suppressions", ["--base", "HEAD~1"]);
  assert.equal(raised.status, 1);
  assert.match(
    raised.stderr,
    /raises lint rule `eslint\/max-params` from 2 on the base to 3\./,
  );
  assert.match(raised.stderr, /ruleset bypass/);
  put(root, "src/a.ts", "export const clean = true;\n");
  put(root, "guardrails.suppressions.json", budget(undefined));
  commit(root);
  assert.match(
    bin(root, "suppressions", ["--base", "HEAD~2"]).stderr,
    /removes lint rule `eslint\/max-params`, which has ceiling 2 on the base/,
  );
  put(root, "guardrails.suppressions.json", budget(0));
  commit(root);
  const lowered = bin(root, "suppressions", ["--base", "HEAD~3"]);
  assert.equal(lowered.status, 0, lowered.stderr);
});

test("a base without a budget, a first adoption, passes", (t) => {
  const root = testRepo(t);
  linkOxlint(root);
  put(root, "src/a.ts", DIRECTIVE);
  commit(root);
  put(root, "guardrails.suppressions.json", budget(1));
  commit(root);
  const adoption = bin(root, "suppressions", ["--base", "HEAD~1"]);
  assert.equal(adoption.status, 0, adoption.stderr);
});

test("CI compares with GITHUB_BASE_REF, fetching it into a shallow checkout, and locally with origin/HEAD", (t) => {
  const remote = mkdtempSync(join(tmpdir(), "antelope-remote-"));
  t.after(() => rmSync(remote, { recursive: true, force: true }));
  git(remote, ["init", "-q", "--bare"]);
  const root = testRepo(t);
  linkOxlint(root);
  put(root, "guardrails.suppressions.json", budget(0));
  commit(root);
  git(root, ["remote", "add", "origin", remote]);
  git(root, ["push", "-q", "origin", "HEAD:refs/heads/main"]);
  git(root, ["update-ref", "-d", "refs/remotes/origin/main"]);
  put(root, "src/a.ts", DIRECTIVE);
  put(root, "guardrails.suppressions.json", budget(1));
  commit(root);
  const ci = bin(root, "suppressions", [], { GITHUB_BASE_REF: "main" });
  assert.equal(ci.status, 1);
  assert.match(ci.stderr, /raises lint rule `eslint\/max-params` from 0/);
  assert.equal(bin(root, "suppressions").status, 0);
  git(root, [
    "symbolic-ref",
    "refs/remotes/origin/HEAD",
    "refs/remotes/origin/main",
  ]);
  assert.equal(bin(root, "suppressions").status, 1);
});

test("CI names the missing base ref when the fetch fails, and uses a local origin ref without fetching", (t) => {
  const root = testRepo(t);
  linkOxlint(root);
  put(root, "guardrails.suppressions.json", budget(0));
  commit(root);
  git(root, ["remote", "add", "origin", join(tmpdir(), "antelope-missing")]);
  const ci = bin(root, "suppressions", [], { GITHUB_BASE_REF: "main" });
  assert.equal(ci.status, 1);
  assert.match(ci.stderr, /refs\/remotes\/origin\/main is missing/);
  assert.match(ci.stderr, /fetching main from origin failed/);
  assert.doesNotMatch(ci.stderr, /Command failed/);
  git(root, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
  const local = bin(root, "suppressions", [], { GITHUB_BASE_REF: "main" });
  assert.equal(local.status, 0, local.stderr);
});
