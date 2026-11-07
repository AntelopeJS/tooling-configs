import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { put } from "../guardrails/helpers/test-repo.ts";
import {
  CHECKS,
  evidence,
  feature,
  newRun,
  PUBLISH_DOORS,
  ran,
  verify,
  verifyRepo,
} from "./helpers/verify-repo.ts";

const SKILL = ".agents/skills/verify-module";

/** Two jobs run at once only where half the cores is at least two. */
const TWO_JOBS = availableParallelism() < 4 && "needs 4 cores for --jobs 2";

function exits(id: string, code: number, wait = 0): string {
  return `${JSON.stringify(id)}: {
      title: "${id} exits ${code}",
      entryPoint: "node",
      async run(context) {
        await new Promise((resolve) => setTimeout(resolve, ${wait}));
        const result = await context.command("node exits ${code}", process.execPath, ["-e", "process.exitCode = ${code}"]);
        context.expect(result.folder, [exitIs(result, 0)]);
      },
    }`;
}

/** Journeys that pass, fail, take their time, meet another journey, kill their own process or leave an uncaught error. */
function config(barrier: string): string {
  return `import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { equal, exitIs } from ${JSON.stringify(CHECKS)};
const meet = async (context) => {
  mkdirSync(${JSON.stringify(barrier)}, { recursive: true });
  writeFileSync(join(${JSON.stringify(barrier)}, context.work.replaceAll("/", "_")), "");
  for (let waited = 0; waited < 5000; waited += 20) {
    if (readdirSync(${JSON.stringify(barrier)}).length >= 2) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
};
export default {
  doors: ${PUBLISH_DOORS},
  journeys: {
    ${exits("shared", 0)},
    ${exits("own", 0)},
    ${exits("bad", 3)},
    ${exits("slow", 0, 800)},
    "meet-a": {
      title: "waits until a journey of another feature runs beside it",
      entryPoint: "node",
      async run(context) {
        context.expect(context.step("meet-a"), [equal("another journey ran at the same time", await meet(context), true)]);
      },
    },
    "meet-b": {
      title: "waits until a journey of another feature runs beside it",
      entryPoint: "node",
      async run(context) {
        context.expect(context.step("meet-b"), [equal("another journey ran at the same time", await meet(context), true)]);
      },
    },
    "killed": {
      title: "kills its own process",
      entryPoint: "node",
      async run() {
        process.kill(process.pid, "SIGKILL");
      },
    },
    "timer": {
      title: "leaves a timer that throws",
      entryPoint: "node",
      async run(context) {
        setTimeout(() => { throw new Error("async boom"); }, 20);
        await new Promise((resolve) => setTimeout(resolve, 300));
        const result = await context.command("node exits 0", process.execPath, ["-e", "process.exitCode = 0"]);
        context.expect(result.folder, [exitIs(result, 0)]);
      },
    },
  },
};
`;
}

/** A repository whose diff touches `api` only, so its plan runs smoke then api; `docs` runs only when named. */
function repo(t: TestContext, features: Record<string, string[]>) {
  const tmp = mkdtempSync(join(tmpdir(), "verify-jobs-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const root = verifyRepo(t, {
    "README.md": "# Demo\n",
    "src/api.ts": "export const api = 1;\n",
    [`${SKILL}/verify.config.ts`]: config(join(tmp, "barrier")),
    ...Object.fromEntries(
      Object.entries(features).map(([name, journeys]) => [
        `${SKILL}/features/${name}.md`,
        feature(
          { api: ["src/**"], smoke: [] }[name] ?? [`${name}/**`],
          journeys,
        ),
      ]),
    ),
  });
  put(root, "src/api.ts", "export const api = 2;\n");
  return { root, tmp, run: newRun(root, tmp) };
}

function untimed(stdout: string): string {
  return stdout.replace(/ \(\d+\.\d s\)$/gm, "");
}

function statuses(run: string, name: string): string[] {
  return evidence(run, `${name}/feature.json`).map(
    (result: { journey: string; status: string; reusedFrom?: string }) =>
      `${result.journey} ${result.status} ${result.reusedFrom ?? "-"}`,
  );
}

test(
  "journey --plan --jobs 2 runs the planned features at once; a call that ignores --jobs and runs them one after another never lets the two meet",
  { skip: TWO_JOBS },
  (t) => {
    const { root, tmp, run } = repo(t, { smoke: ["meet-a"], api: ["meet-b"] });
    const planned = verify(root, tmp, [
      "journey",
      run,
      "--plan",
      "--jobs",
      "2",
    ]);
    assert.equal(planned.status, 0, planned.stdout + planned.stderr);
    assert.equal(
      untimed(planned.stdout),
      "PASS smoke/meet-a\nPASS api/meet-b\n",
    );
  },
);

test(
  "journey --plan --jobs 2 prints and records what --plan prints and records, each feature whole and in plan order; a call that prints each feature as it ends prints the quick api before the slow smoke",
  { skip: TWO_JOBS },
  (t) => {
    const features = { smoke: ["slow", "own"], api: ["bad", "shared"] };
    const one = repo(t, features);
    const sequential = verify(one.root, one.tmp, [
      "journey",
      one.run,
      "--plan",
    ]);
    const other = repo(t, features);
    const jobs = verify(other.root, other.tmp, [
      "journey",
      other.run,
      "--plan",
      "--jobs",
      "2",
    ]);
    assert.equal(
      untimed(sequential.stdout),
      "PASS smoke/slow\nPASS smoke/own\nFAIL api/bad\n    01-node-exits-3: exit code 0 (exit code 3)\nPASS api/shared\n",
    );
    assert.equal(untimed(jobs.stdout), untimed(sequential.stdout));
    assert.equal(jobs.stderr, sequential.stderr);
    assert.equal(jobs.status, 1);
    for (const name of ["smoke", "api"])
      assert.deepEqual(statuses(other.run, name), statuses(one.run, name));
  },
);

test(
  "with --jobs, a failing, unknown, killed or crashing feature makes the call exit 1 and names itself while every other feature still runs; a call that stops at the first failure, returns the last feature's code or hides a signal fails it",
  { skip: TWO_JOBS },
  (t) => {
    const { root, tmp, run } = repo(t, {
      smoke: ["own"],
      api: ["bad"],
      docs: ["killed"],
      crash: ["timer"],
      last: ["shared"],
    });
    const result = verify(root, tmp, [
      "journey",
      run,
      "--features",
      "api,nope,docs,crash,smoke,last",
      "--jobs",
      "2",
    ]);
    assert.equal(result.status, 1);
    assert.equal(
      untimed(result.stdout),
      "FAIL api/bad\n    01-node-exits-3: exit code 0 (exit code 3)\nPASS smoke/own\nPASS last/shared\n",
    );
    assert.equal(
      result.stderr,
      "Unknown feature nope: no features/nope.md\ndocs: its journey process ended on SIGKILL\ncrash: a journey left an uncaught error: async boom\n",
    );
    assert.deepEqual(statuses(run, "last"), ["shared PASS -"]);
  },
);

test(
  "with --jobs, a feature that shares a journey with an earlier one waits for it and reuses its PASS, as without --jobs; starting both at once runs the slow journey twice and prints no reuse",
  { skip: TWO_JOBS },
  (t) => {
    const { root, tmp, run } = repo(t, {
      smoke: ["slow"],
      api: ["slow", "own"],
    });
    const planned = verify(root, tmp, [
      "journey",
      run,
      "--plan",
      "--jobs",
      "2",
    ]);
    assert.equal(planned.status, 0, planned.stdout + planned.stderr);
    assert.equal(
      untimed(planned.stdout),
      "PASS smoke/slow\nPASS api/slow (reuses smoke/slow, not run again)\nPASS api/own\n",
    );
    assert.equal(ran(run, "api/slow"), false);
  },
);

test("--jobs 1 keeps the one-process loop: a journey's uncaught error still ends the call and names the features left unrun; a call that gives --jobs 1 a process per feature runs api", (t) => {
  const { root, tmp, run } = repo(t, { smoke: ["timer"], api: ["shared"] });
  const planned = verify(root, tmp, ["journey", run, "--plan", "--jobs", "1"]);
  assert.equal(planned.status, 1);
  assert.equal(
    planned.stderr,
    "smoke: a journey left an uncaught error: async boom\nnot run: api\n",
  );
  assert.equal(ran(run, "api/shared"), false);
});

test("--jobs above 1 is refused before anything runs when verify.config.ts declares services; a call that runs features at once beside a per-journey service reset runs smoke", (t) => {
  const { root, tmp, run } = repo(t, { smoke: ["own"], api: ["shared"] });
  put(
    root,
    `${SKILL}/verify.config.ts`,
    config(join(tmp, "barrier")).replace(
      "  journeys: {",
      '  services: { mongo: { image: "mongo:7", port: 27017, ready: ["true"], reset: ["true"] } },\n  journeys: {',
    ),
  );
  const refused = verify(root, tmp, ["journey", run, "--plan", "--jobs", "2"]);
  assert.equal(refused.status, 1);
  assert.equal(refused.stdout, "");
  assert.match(
    refused.stderr,
    /^--jobs 2 refused: verify\.config\.ts declares services \(mongo\)/,
  );
  assert.equal(ran(run, "smoke/own"), false);
});

test("--jobs refuses a count that is not a whole number above 0, and a single feature's call, before anything runs; accepting them runs smoke", (t) => {
  const { root, tmp, run } = repo(t, { smoke: ["own"], api: ["shared"] });
  for (const args of [
    ["--plan", "--jobs", "0"],
    ["--plan", "--jobs", "two"],
    ["--features", "smoke", "--jobs", "1.5"],
    ["smoke", "--jobs", "2"],
  ]) {
    const refused = verify(root, tmp, ["journey", run, ...args]);
    assert.equal(refused.status, 1, args.join(" "));
    assert.equal(refused.stdout, "", args.join(" "));
    assert.notEqual(refused.stderr, "", args.join(" "));
  }
  assert.equal(ran(run, "smoke/own"), false);
});
