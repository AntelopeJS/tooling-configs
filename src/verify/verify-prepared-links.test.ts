import assert from "node:assert/strict";
import test from "node:test";

import { preparedRepo } from "./helpers/prepared-repo.ts";
import { newRun, verify } from "./helpers/verify-repo.ts";

test("a file the build hard-linked from elsewhere, as pnpm links its store, is linked into each copy while a file of the build's own is copied", (t) => {
  const { root, tmp, builds, store, seen } = preparedRepo(t);
  const stored = store();
  const run = newRun(root, tmp);
  assert.equal(verify(root, tmp, ["journey", run, "smoke"]).status, 0);
  const copied = verify(root, tmp, ["journey", run, "shared"]);
  assert.equal(copied.status, 0, copied.stdout);
  assert.equal(builds(), 1);
  assert.deepEqual(seen(), { ino: stored, value: 1 });
});

test("a shared file the filesystem can link no more is copied, so the copy still succeeds", (t) => {
  const { root, tmp, builds, store, seen, fullLinks } = preparedRepo(t);
  const stored = store();
  const run = newRun(root, tmp);
  assert.equal(verify(root, tmp, ["journey", run, "smoke"]).status, 0);
  const copied = verify(root, tmp, ["journey", run, "shared"], fullLinks());
  assert.equal(copied.status, 0, copied.stdout);
  assert.equal(builds(), 1);
  assert.notEqual(seen().ino, stored);
});

test("two hard links the build made inside its folder are copied, so a write through one never reaches the next journey", (t) => {
  const { root, tmp, builds, flag } = preparedRepo(t);
  flag("twin");
  const run = newRun(root, tmp);
  const wrote = verify(root, tmp, ["journey", run, "tree"]);
  assert.equal(wrote.status, 0, wrote.stdout);
  assert.equal(builds(), 1);
});

test("an edit of a linked file in one journey's copy reaches neither the file it was linked from nor a later journey's copy", (t) => {
  const { root, tmp, builds, store, seen } = preparedRepo(t);
  const stored = store();
  const run = newRun(root, tmp);
  assert.equal(verify(root, tmp, ["journey", run, "smoke"]).status, 0);
  const edited = verify(root, tmp, ["journey", run, "edits"]);
  assert.equal(edited.status, 0, edited.stdout);
  const copied = verify(root, tmp, ["journey", run, "shared"]);
  assert.equal(copied.status, 0, copied.stdout);
  assert.equal(builds(), 1);
  assert.equal(seen().ino, stored);
});

test("an edit of a linked file that fails to write leaves the file as it was and no temporary file", (t) => {
  const { root, tmp, builds, store, failedEdit, fullDisk } = preparedRepo(t);
  store();
  const run = newRun(root, tmp);
  assert.equal(verify(root, tmp, ["journey", run, "smoke"]).status, 0);
  const failed = verify(root, tmp, ["journey", run, "full"], fullDisk());
  assert.equal(failed.status, 0, failed.stdout);
  assert.equal(builds(), 1);
  assert.deepEqual(failedEdit(), { failure: "ENOSPC", entries: [] });
});

test("an edit of a read-only linked file fails as it does for a file with no other link", (t) => {
  const { root, tmp, builds, store, failedEdit } = preparedRepo(t);
  store(0o444);
  const run = newRun(root, tmp);
  assert.equal(verify(root, tmp, ["journey", run, "smoke"]).status, 0);
  const failed = verify(root, tmp, ["journey", run, "full"]);
  assert.equal(failed.status, 0, failed.stdout);
  assert.equal(builds(), 1);
  assert.deepEqual(failedEdit(), { failure: "EACCES", entries: [] });
});
