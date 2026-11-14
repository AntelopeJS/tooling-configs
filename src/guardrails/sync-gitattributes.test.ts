import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { formatCeilings } from "./ceilings.ts";
import { bin, commit, put, read, testRepo } from "./helpers/test-repo.ts";

function seededRepo(t: Parameters<typeof testRepo>[0]): string {
  const root = testRepo(t);
  put(
    root,
    "guardrails.ratchet.json",
    formatCeilings({ rules: { "eslint/max-params": 123 }, oversizeFiles: {} }),
  );
  return root;
}

const PROFILES = [[], ["--profile", "template"]] as const;

for (const profile of PROFILES)
  test(`sync ${profile.join(" ") || "--profile full"} fails the check on a repository without the LF .gitattributes line, then writes it so a clone with core.autocrlf=true checks a shell script out with LF`, (t) => {
    const root = seededRepo(t);
    const drift = bin(root, "sync", [...profile, "--check"]);
    assert.equal(drift.status, 1);
    assert.match(
      drift.stdout,
      /^Drift: \.gitattributes; run antelopejs-sync$/m,
    );
    assert.equal(bin(root, "sync", [...profile]).status, 0);
    assert.equal(bin(root, "sync", [...profile, "--check"]).status, 0);
    put(root, "start.sh", "#!/bin/sh\nset -eu\n");
    commit(root);
    const clone = mkdtempSync(join(tmpdir(), "antelope-gitattributes-"));
    t.after(() => rmSync(clone, { recursive: true, force: true }));
    execFileSync(
      "git",
      ["-c", "core.autocrlf=true", "clone", "-q", root, clone],
      { stdio: "ignore" },
    );
    assert.equal(read(clone, "start.sh"), "#!/bin/sh\nset -eu\n");
  });

test("sync puts the LF line before the patterns a .gitattributes already lists, so they still override it, and leaves a file that has the line as it is", (t) => {
  const root = seededRepo(t);
  put(root, ".gitattributes", "*.png binary\n");
  assert.equal(bin(root, "sync").status, 0);
  assert.equal(
    read(root, ".gitattributes"),
    "* text=auto eol=lf\n*.png binary\n",
  );
  put(root, ".gitattributes", "*.bat eol=crlf\n*   text=auto   eol=lf\n");
  assert.equal(bin(root, "sync").status, 0);
  assert.equal(
    read(root, ".gitattributes"),
    "*.bat eol=crlf\n*   text=auto   eol=lf\n",
  );
});
