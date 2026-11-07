import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { put, read } from "../guardrails/helpers/test-repo.ts";
import {
  CHECKS,
  evidence,
  feature,
  newRun,
  PUBLISH_DOORS,
  verify,
  verifyRepo,
} from "./helpers/verify-repo.ts";

const SKILL = ".agents/skills/verify-module";

const CONFIG = `import { exitIs } from ${JSON.stringify(CHECKS)};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export default {
  doors: ${PUBLISH_DOORS},
  setup: [["node", "-e", "0"]],
  journeys: {
    steps: {
      title: "four steps of different lengths",
      entryPoint: "node",
      async run(context) {
        for (const ms of [100, 600, 0, 350]) {
          const folder = context.step("wait " + ms);
          await sleep(ms);
          context.expect(folder, [{ name: "waited", pass: true, detail: "" }]);
        }
      },
    },
    timed: {
      title: "waits between commands",
      entryPoint: "node",
      async run(context) {
        await sleep(300);
        const first = await context.command("first", process.execPath, ["-e", "0"]);
        await sleep(500);
        const second = await context.command("second", process.execPath, ["-e", "0"]);
        await sleep(400);
        context.expect(first.folder, [exitIs(first, 0)]);
        context.expect(second.folder, [exitIs(second, 0)]);
      },
    },
    quick: {
      title: "one fast command",
      entryPoint: "node",
      async run(context) {
        const result = await context.command("quick", process.execPath, ["-e", "0"]);
        context.expect(result.folder, [exitIs(result, 0)]);
      },
    },
  },
};
`;

function timingRepo(t: TestContext, journeys: string[]) {
  const tmp = mkdtempSync(join(tmpdir(), "verify-timing-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const root = verifyRepo(t, {
    "README.md": "# Demo\n",
    [`${SKILL}/verify.config.ts`]: CONFIG,
    [`${SKILL}/features/smoke.md`]: feature([], journeys),
  });
  return { root, tmp, run: newRun(root, tmp) };
}

function judged(root: string, tmp: string, run: string) {
  put(
    run,
    "evidence/judgement.json",
    JSON.stringify({
      doors: { none: "no door" },
      docs: [{ page: "README.md", matches: true }],
      verifier: "a fresh thread",
    }),
  );
  return verify(root, tmp, ["verdict", run, "--pr", "7"]);
}

test("the verdict times every phase and names a journey's three slowest steps, slowest first; a verdict that lists the first three steps in order, lists all four, or leaves out setup fails", (t) => {
  const { root, tmp, run } = timingRepo(t, ["steps"]);
  const ran = verify(root, tmp, ["journey", run, "smoke"]);
  assert.equal(ran.status, 0, ran.stdout + ran.stderr);
  assert.match(ran.stdout, /^PASS smoke\/steps \(\d+\.\d s\)\n$/);
  const verdict = judged(root, tmp, run);
  assert.equal(verdict.status, 0, verdict.stderr);
  assert.match(
    verdict.stdout,
    /\n### Attention\n- Nothing\.\n\n### Timing\n\| Phase \| Time \|\n\|---\|---\|\n\| prune old runs \| \d+\.\d s \|\n\| setup\/01-node \| \d+\.\d s \|\n\| journey smoke\/steps \| \d+\.\d s \(slowest steps: `02-wait-600` \d+\.\d s, `04-wait-350` \d+\.\d s, `01-wait-100` \d+\.\d s\) \|\n\| \*\*Total measured\*\* \(commands only; agent time between commands is not included\) \| \d+\.\d s \|\n\nEvidence:/,
  );
  assert.doesNotMatch(verdict.stdout, /03-wait-0/);
  const { timings } = evidence(run, "verdict.json");
  assert.deepEqual(
    timings.journeys[0].slowestSteps.map((step: { step: string }) => step.step),
    ["02-wait-600", "04-wait-350", "01-wait-100"],
  );
  assert.deepEqual(
    timings.setup.map((entry: { phase: string }) => entry.phase),
    ["prune old runs", "setup/01-node"],
  );
  const parts = [...timings.setup, ...timings.journeys].map(
    (entry: { ms: number }) => entry.ms,
  );
  assert.equal(
    timings.totalMs,
    parts.reduce((total: number, ms: number) => total + ms, 0),
  );
});

test("a step lasts from its step call to the next one and the last until the journey ends, and the journey total keeps the time before the first step; a clock that times only the commands or sums the steps fails", (t) => {
  const { root, tmp, run } = timingRepo(t, ["timed"]);
  assert.equal(verify(root, tmp, ["journey", run, "smoke"]).status, 0);
  const result = evidence(run, "smoke/timed/result.json");
  const steps: { step: string; ms: number }[] = result.stepMs;
  assert.deepEqual(
    steps.map((entry) => entry.step),
    ["01-first", "02-second"],
  );
  assert.ok(steps[0].ms >= 480, `first step ${steps[0].ms} ms`);
  assert.ok(steps[1].ms >= 380, `last step ${steps[1].ms} ms`);
  const stepTotal = steps.reduce((total, entry) => total + entry.ms, 0);
  assert.ok(
    result.ms - stepTotal >= 280,
    `journey ${result.ms} ms, steps ${stepTotal} ms`,
  );
});

test("a run.json and results written before timings existed still render a verdict, with `not measured` rows and no NaN; a reader that assumes the fields exist crashes", (t) => {
  const { root, tmp, run } = timingRepo(t, ["quick"]);
  const old = JSON.parse(read(run, "run.json"));
  delete old.timings;
  put(run, "run.json", JSON.stringify(old));
  const ran = verify(root, tmp, ["journey", run, "smoke"]);
  assert.equal(ran.status, 0, ran.stdout + ran.stderr);
  for (const file of ["smoke/quick/result.json", "smoke/feature.json"]) {
    const value = evidence(run, file);
    for (const result of Array.isArray(value) ? value : [value]) {
      delete result.ms;
      delete result.stepMs;
    }
    put(run, `evidence/${file}`, JSON.stringify(value));
  }
  const verdict = judged(root, tmp, run);
  assert.equal(verdict.status, 0, verdict.stderr);
  assert.match(
    verdict.stdout,
    /\| Phase \| Time \|\n\|---\|---\|\n\| new \(setup, pack, services, sources\) \| not measured \|\n\| journey smoke\/quick \| not measured \|\n\| \*\*Total measured\*\*[^|]*\| 0\.0 s \|\n/,
  );
  assert.doesNotMatch(verdict.stdout, /NaN|undefined/);
  const { timings } = evidence(run, "verdict.json");
  assert.deepEqual(timings.setup, []);
  assert.equal(timings.journeys[0].ms, null);
  assert.equal(timings.totalMs, 0);
});
