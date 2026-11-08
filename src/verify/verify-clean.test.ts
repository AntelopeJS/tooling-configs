import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";

import { put, read } from "../guardrails/helpers/test-repo.ts";
import {
  CHECKS,
  feature,
  newRun,
  PUBLISH_DOORS,
  verify,
  verifyRepo,
} from "./helpers/verify-repo.ts";

const SKILL = ".agents/skills/verify-module";

const CONFIG = `import { exitIs } from ${JSON.stringify(CHECKS)};
export default {
  doors: ${PUBLISH_DOORS},
  journeys: {
    ok: {
      title: "node exits 0",
      entryPoint: "node",
      async run(context) {
        const result = await context.command("node exits 0", process.execPath, ["-e", ""]);
        context.expect(result.folder, [exitIs(result, 0)]);
      },
    },
  },
};
`;

function checkout(t: TestContext): string {
  return verifyRepo(t, {
    "README.md": "# Demo\n",
    [`${SKILL}/verify.config.ts`]: CONFIG,
    [`${SKILL}/features/smoke.md`]: feature([], ["ok"]),
  });
}

/** Two checkouts of one repository sharing a runs folder, and a run the first created with a scratch folder in it. */
function twoCheckouts(t: TestContext) {
  const tmp = mkdtempSync(join(tmpdir(), "verify-clean-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const mine = checkout(t);
  const other = checkout(t);
  const run = newRun(mine, tmp);
  put(run, "scratch/file", "kept\n");
  return { mine, other, tmp, run };
}

test("clean refuses a run another checkout created and leaves its scratch folders, where a clean that trusts any run.json wipes another session's run", (t) => {
  const { other, tmp, run } = twoCheckouts(t);
  const cleaned = verify(other, tmp, ["clean", run]);
  assert.equal(cleaned.status, 1);
  assert.match(cleaned.stderr, /created by another checkout/);
  assert.equal(existsSync(join(run, "scratch/file")), true);
});

test("clean refuses the shared runs folder and a repository's folder of runs, where a clean that walks the folder it is given deletes every session's runs", (t) => {
  const { mine, tmp, run } = twoCheckouts(t);
  const runs = dirname(dirname(run));
  writeFileSync(join(runs, "run.json"), "{}\n");
  writeFileSync(join(dirname(run), "run.json"), "{}\n");
  for (const shared of [dirname(run), runs, `${dirname(run)}/..`]) {
    const cleaned = verify(mine, tmp, ["clean", shared]);
    assert.equal(cleaned.status, 1, shared);
    assert.match(cleaned.stderr, /not one run/);
  }
  assert.equal(existsSync(join(run, "scratch/file")), true);
});

test("clean refuses a run.json that names another folder, where a clean that deletes under the recorded dir wipes the folder it names", (t) => {
  const { mine, tmp, run } = twoCheckouts(t);
  const copy = newRun(mine, tmp);
  writeFileSync(join(copy, "run.json"), read(run, "run.json"));
  const cleaned = verify(mine, tmp, ["clean", copy]);
  assert.equal(cleaned.status, 1);
  assert.match(cleaned.stderr, /records the folder/);
  assert.equal(existsSync(join(run, "scratch/file")), true);
});

test("clean still cleans a run this checkout created", (t) => {
  const { mine, tmp, run } = twoCheckouts(t);
  const cleaned = verify(mine, tmp, ["clean", run]);
  assert.equal(cleaned.status, 0, cleaned.stderr);
  assert.equal(existsSync(join(run, "scratch")), false);
  assert.equal(existsSync(join(run, "run.json")), true);
});
