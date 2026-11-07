import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { read } from "../guardrails/helpers/test-repo.ts";
import {
  CHECKS,
  feature,
  newRun,
  PUBLISH_DOORS,
  runEntries,
  verify,
  verifyRepo,
} from "./helpers/verify-repo.ts";

const SKILL = ".agents/skills/verify-module";

/** Logs the build, writes `value.txt` with a relative `link` and an absolute `abs` to it, writes a file into HOME, makes a FIFO while the fifo marker exists, and exits 1 while the fail marker exists. */
const BUILD = `const fs = require("fs");
const path = require("path");
const [folder, log, flags] = process.argv.slice(1);
fs.appendFileSync(log, "built\\n");
fs.writeFileSync(path.join(folder, "value.txt"), "built\\n");
fs.symlinkSync("value.txt", path.join(folder, "link"));
fs.symlinkSync(path.join(folder, "value.txt"), path.join(folder, "abs"));
fs.writeFileSync(path.join(process.env.HOME, "from-build"), "");
if (fs.existsSync(path.join(flags, "fifo")))
  require("child_process").execFileSync("mkfifo", [path.join(folder, "pipe")]);
process.exitCode = fs.existsSync(path.join(flags, "fail")) ? 1 : 0;`;

function config(log: string, flags: string): string {
  return `import { existsSync, readdirSync, readFileSync, readlinkSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { equal, exitIs } from ${JSON.stringify(CHECKS)};
const prepare = (context) =>
  context.prepared("tree", async (folder) => {
    const made = await context.command("build", process.execPath, ["-e", ${JSON.stringify(BUILD)}, folder, ${JSON.stringify(log)}, ${JSON.stringify(flags)}]);
    if (!existsSync(join(${JSON.stringify(flags)}, "nocheck"))) context.expect(made.folder, [exitIs(made, 0)]);
  });
export default {
  doors: ${PUBLISH_DOORS},
  journeys: {
    reader: {
      title: "reads the prepared tree",
      entryPoint: "node",
      async run(context) {
        const folder = await prepare(context);
        const after = context.tree("prepared tree", folder);
        context.expect(after.folder, [
          equal("value.txt is as built", readFileSync(join(folder, "value.txt"), "utf8"), "built\\n"),
          equal("HOME is as it was", readdirSync(context.home), []),
        ]);
      },
    },
    writer: {
      title: "writes through the prepared link",
      entryPoint: "node",
      async run(context) {
        const folder = await prepare(context);
        appendFileSync(join(folder, "link"), "dirty\\n");
        const after = context.tree("written tree", folder);
        context.expect(after.folder, [equal("value.txt took the write", readFileSync(join(folder, "value.txt"), "utf8"), "built\\ndirty\\n")]);
      },
    },
    linker: {
      title: "writes through the absolute prepared link",
      entryPoint: "node",
      async run(context) {
        const folder = await prepare(context);
        appendFileSync(join(folder, "abs"), "linked\\n");
        const after = context.tree("linked tree", folder);
        context.expect(after.folder, [
          equal("abs points into this journey's folder", readlinkSync(join(folder, "abs")), join(folder, "value.txt")),
          equal("value.txt took the write", readFileSync(join(folder, "value.txt"), "utf8"), "built\\nlinked\\n"),
        ]);
      },
    },
  },
};
`;
}

function preparedRepo(t: TestContext) {
  const tmp = mkdtempSync(join(tmpdir(), "verify-prepared-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const log = join(tmp, "builds.log");
  const flags = join(tmp, "flags");
  mkdirSync(flags);
  const root = verifyRepo(t, {
    "README.md": "# Demo\n",
    "src/tree.ts": "export const tree = 1;\n",
    [`${SKILL}/verify.config.ts`]: config(log, flags),
    [`${SKILL}/features/smoke.md`]: feature([], ["reader"]),
    [`${SKILL}/features/tree.md`]: feature(["src/**"], ["writer", "reader"]),
    [`${SKILL}/features/links.md`]: feature([], ["linker"]),
  });
  const builds = () =>
    existsSync(log) ? read(tmp, "builds.log").split("\n").length - 1 : 0;
  const flag = (name: string) => writeFileSync(join(flags, name), "");
  const unflag = (name: string) => rmSync(join(flags, name));
  return { root, tmp, builds, flag, unflag };
}

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
    /^tree: \S+\/work\/tree\/reader\/tree is a copy of what smoke\/reader prepared;/,
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
    /^FAIL smoke\/reader\n {4}02-build: exit code 0/m,
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

test("a build whose folder holds a FIFO is not kept, since a copy would drop it", (t) => {
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
});

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
