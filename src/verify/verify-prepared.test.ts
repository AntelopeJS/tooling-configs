import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

/** Logs the build, writes `value.txt` and a relative `link` to it, writes a file into HOME, and exits 1 while the fail marker exists. */
const BUILD = `const fs = require("fs");
const path = require("path");
const [folder, log, fail] = process.argv.slice(1);
fs.appendFileSync(log, "built\\n");
fs.writeFileSync(path.join(folder, "value.txt"), "built\\n");
fs.symlinkSync("value.txt", path.join(folder, "link"));
fs.writeFileSync(path.join(process.env.HOME, "from-build"), "");
process.exitCode = fs.existsSync(fail) ? 1 : 0;`;

function config(log: string, fail: string): string {
  return `import { readdirSync, readFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { equal, exitIs } from ${JSON.stringify(CHECKS)};
const prepare = (context) =>
  context.prepared("tree", async (folder) => {
    const made = await context.command("build", process.execPath, ["-e", ${JSON.stringify(BUILD)}, folder, ${JSON.stringify(log)}, ${JSON.stringify(fail)}]);
    context.expect(made.folder, [exitIs(made, 0)]);
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
  },
};
`;
}

function preparedRepo(t: TestContext) {
  const tmp = mkdtempSync(join(tmpdir(), "verify-prepared-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const log = join(tmp, "builds.log");
  const fail = join(tmp, "fail");
  const root = verifyRepo(t, {
    "README.md": "# Demo\n",
    "src/tree.ts": "export const tree = 1;\n",
    [`${SKILL}/verify.config.ts`]: config(log, fail),
    [`${SKILL}/features/smoke.md`]: feature([], ["reader"]),
    [`${SKILL}/features/tree.md`]: feature(["src/**"], ["writer", "reader"]),
  });
  const builds = () =>
    existsSync(log) ? read(tmp, "builds.log").split("\n").length - 1 : 0;
  return { root, tmp, fail, builds };
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
      "evidence/tree/reader/01-prepared-tree/build/01-build/exit-code.txt",
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
  const { root, tmp, fail, builds } = preparedRepo(t);
  const run = newRun(root, tmp);
  writeFileSync(fail, "");
  const failed = verify(root, tmp, ["journey", run, "smoke"]);
  assert.equal(failed.status, 1);
  assert.match(
    failed.stdout,
    /^FAIL smoke\/reader\n {4}01-build: exit code 0/m,
  );
  rmSync(fail);
  const rebuilt = verify(root, tmp, ["journey", run, "smoke"]);
  assert.equal(rebuilt.status, 0, rebuilt.stdout);
  assert.equal(builds(), 2);
});

test("clean deletes what the run kept, so a journey after it builds again", (t) => {
  const { root, tmp, builds } = preparedRepo(t);
  const run = newRun(root, tmp);
  assert.equal(verify(root, tmp, ["journey", run, "smoke"]).status, 0);
  const cleaned = verify(root, tmp, ["clean", run]);
  assert.equal(cleaned.status, 0, cleaned.stderr);
  assert.deepEqual(runEntries(run), ["evidence", "run.json"]);
  assert.equal(verify(root, tmp, ["journey", run, "smoke"]).status, 0);
  assert.equal(builds(), 2);
});
