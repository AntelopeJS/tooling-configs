import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { read } from "../guardrails/helpers/test-repo.ts";
import { preparedRepo } from "./helpers/prepared-repo.ts";
import { newRun, runEntries, verify } from "./helpers/verify-repo.ts";

test("a later journey command copies what the first journey built, with its build's evidence, and a build never touches the journey's HOME", (t) => {
  const { root, tmp, builds } = preparedRepo(t);
  const run = newRun(root, tmp);
  const built = verify(root, tmp, ["journey", run, "smoke"]);
  assert.equal(built.status, 0, built.stdout);
  const copied = verify(root, tmp, ["journey", run, "tree", "reader"]);
  assert.equal(copied.status, 0, copied.stdout);
  assert.equal(builds(), 1);
  assert.match(
    read(run, "evidence/tree/reader/01-prepared-tree/prepared.txt"),
    /^tree: \S+[\\/]work[\\/]tree[\\/]reader[\\/]tree is a copy of what smoke\/reader prepared;/,
  );
  assert.equal(
    read(
      run,
      "evidence/tree/reader/01-prepared-tree/build/02-build/exit-code.txt",
    ),
    "0\n",
  );
});

test("every journey writes to its own folder, so a write by the journey that built or by one that copied never reaches the next journey", (t) => {
  const { root, tmp } = preparedRepo(t);
  const built = newRun(root, tmp);
  const builderWrote = verify(root, tmp, ["journey", built, "tree"]);
  assert.equal(builderWrote.status, 0, builderWrote.stdout);
  const copied = newRun(root, tmp);
  assert.equal(verify(root, tmp, ["journey", copied, "smoke"]).status, 0);
  const copierWrote = verify(root, tmp, ["journey", copied, "tree"]);
  assert.equal(copierWrote.status, 0, copierWrote.stdout);
});

test("a build that fails a check is not kept, so the next journey builds again", (t) => {
  const { root, tmp, builds, flag, unflag } = preparedRepo(t);
  const run = newRun(root, tmp);
  flag("fail");
  const failed = verify(root, tmp, ["journey", run, "smoke"]);
  assert.equal(failed.status, 1);
  assert.match(
    failed.stdout,
    /^FAIL smoke\/reader \(\d+\.\d s\)\n {4}02-build: exit code 0/m,
  );
  unflag("fail");
  const rebuilt = verify(root, tmp, ["journey", run, "tree", "reader"]);
  assert.equal(rebuilt.status, 0, rebuilt.stdout);
  assert.equal(builds(), 2);
});

test("a build that records no check is not kept, so the next journey builds again", (t) => {
  const { root, tmp, builds, flag } = preparedRepo(t);
  const run = newRun(root, tmp);
  flag("nocheck");
  assert.equal(verify(root, tmp, ["journey", run, "smoke"]).status, 0);
  const rebuilt = verify(root, tmp, ["journey", run, "tree", "reader"]);
  assert.equal(rebuilt.status, 0, rebuilt.stdout);
  assert.equal(builds(), 2);
  assert.match(
    read(run, "evidence/smoke/reader/01-prepared-tree/prepared.txt"),
    /not kept: the build recorded no check/,
  );
});

const NO_FIFO = process.platform === "win32" && "Windows has no FIFOs";

test(
  "a build whose folder holds a FIFO is not kept, since a copy would drop it",
  { skip: NO_FIFO },
  (t) => {
    const { root, tmp, builds, flag } = preparedRepo(t);
    const run = newRun(root, tmp);
    flag("fifo");
    assert.equal(verify(root, tmp, ["journey", run, "smoke"]).status, 0);
    const rebuilt = verify(root, tmp, ["journey", run, "tree", "reader"]);
    assert.equal(rebuilt.status, 0, rebuilt.stdout);
    assert.equal(builds(), 2);
    assert.match(
      read(run, "evidence/smoke/reader/01-prepared-tree/prepared.txt"),
      /not kept: pipe is not a file, directory or symlink/,
    );
  },
);

test("an absolute symlink the build made into its folder points into each journey's own copy", (t) => {
  const { root, tmp, builds } = preparedRepo(t);
  const run = newRun(root, tmp);
  assert.equal(verify(root, tmp, ["journey", run, "smoke"]).status, 0);
  const copied = verify(root, tmp, ["journey", run, "links"]);
  assert.equal(copied.status, 0, copied.stdout);
  assert.equal(builds(), 1);
});

test("rerunning the journey that built builds again, and its evidence holds the build", (t) => {
  const { root, tmp, builds } = preparedRepo(t);
  const run = newRun(root, tmp);
  assert.equal(verify(root, tmp, ["journey", run, "smoke"]).status, 0);
  const rerun = verify(root, tmp, ["journey", run, "smoke"]);
  assert.equal(rerun.status, 0, rerun.stdout);
  assert.equal(builds(), 2);
  assert.match(
    read(run, "evidence/smoke/reader/01-prepared-tree/prepared.txt"),
    /was built here by the steps after this one; kept/,
  );
  assert.equal(
    read(run, "evidence/smoke/reader/02-build/exit-code.txt"),
    "0\n",
  );
});

test("clean deletes what the run kept, so a journey after it builds again", (t) => {
  const { root, tmp, builds } = preparedRepo(t);
  const run = newRun(root, tmp);
  assert.equal(verify(root, tmp, ["journey", run, "smoke"]).status, 0);
  const cleaned = verify(root, tmp, ["clean", run]);
  assert.equal(cleaned.status, 0, cleaned.stderr);
  assert.deepEqual(runEntries(run), ["evidence", "run.json"]);
  assert.equal(verify(root, tmp, ["journey", run, "tree", "reader"]).status, 0);
  assert.equal(builds(), 2);
});

test("an absolute symlink to the build's folder itself is kept and points to each journey's own copy", (t) => {
  const { root, tmp, builds, links } = preparedRepo(t);
  links({ self: "<folder>" });
  const run = newRun(root, tmp);
  const built = verify(root, tmp, ["journey", run, "smoke"]);
  assert.equal(built.status, 0, built.stdout);
  const copied = verify(root, tmp, ["journey", run, "shape"]);
  assert.equal(copied.status, 0, copied.stdout);
  assert.equal(builds(), 1);
});

test("two relative links to the build's folder are kept and copied as they are", (t) => {
  const { root, tmp, builds, links } = preparedRepo(t);
  links({ a: ".", b: "." });
  const run = newRun(root, tmp);
  const built = verify(root, tmp, ["journey", run, "smoke"]);
  assert.equal(built.status, 0, built.stdout);
  const copied = verify(root, tmp, ["journey", run, "shape"]);
  assert.equal(copied.status, 0, copied.stdout);
  assert.equal(builds(), 1);
});

test(
  "a link to an outside folder holding a FIFO is kept and copied as it is",
  { skip: NO_FIFO },
  (t) => {
    const { root, tmp, builds, links } = preparedRepo(t);
    const outside = join(tmp, "outside");
    mkdirSync(outside);
    execFileSync("mkfifo", [join(outside, "pipe")]);
    links({ out: outside });
    const run = newRun(root, tmp);
    assert.equal(verify(root, tmp, ["journey", run, "smoke"]).status, 0);
    const copied = verify(root, tmp, ["journey", run, "shape"]);
    assert.equal(copied.status, 0, copied.stdout);
    assert.equal(builds(), 1);
  },
);

const COPIER = "evidence/tree/reader/01-prepared-tree";

test("a journey whose copy fails as what the run kept vanishes removes the partial copy, builds itself and says so", (t) => {
  const { root, tmp, builds, hook } = preparedRepo(t);
  const run = newRun(root, tmp);
  assert.equal(verify(root, tmp, ["journey", run, "smoke"]).status, 0);
  const copier = verify(
    root,
    tmp,
    ["journey", run, "tree", "reader"],
    hook("vanish"),
  );
  assert.equal(copier.status, 0, copier.stdout);
  assert.equal(builds(), 2);
  assert.match(
    read(run, `${COPIER}/prepared.txt`),
    /^tree: copying what the run kept failed \(ENOENT[^)]*\), so \S+\/work\/tree\/reader\/tree was built here by the steps after this one; kept,/,
  );
  assert.equal(existsSync(join(run, COPIER, "build")), false);
});

test("a journey whose copy ends after what the run kept was replaced builds itself and says so", (t) => {
  const { root, tmp, builds, hook } = preparedRepo(t);
  const run = newRun(root, tmp);
  assert.equal(verify(root, tmp, ["journey", run, "smoke"]).status, 0);
  const copier = verify(
    root,
    tmp,
    ["journey", run, "tree", "reader"],
    hook("replace"),
  );
  assert.equal(copier.status, 0, copier.stdout);
  assert.equal(builds(), 2);
  assert.match(
    read(run, `${COPIER}/prepared.txt`),
    /^tree: copying what the run kept failed \(\S+ was replaced while it was copied\), so /,
  );
});
