import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
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

function journey(id: string, code: number): string {
  return `${JSON.stringify(id)}: {
      title: "${id} exits ${code}",
      entryPoint: "node",
      async run(context) {
        const result = await context.command("node exits ${code}", process.execPath, ["-e", "process.exitCode = ${code}"]);
        context.expect(result.folder, [exitIs(result, 0)]);
      },
    }`;
}

const CONFIG = `import { exitIs } from ${JSON.stringify(CHECKS)};
export default {
  doors: ${PUBLISH_DOORS},
  journeys: {
    ${journey("shared", 0)},
    ${journey("own", 0)},
    ${journey("docs", 0)},
    ${journey("bad", 3)},
    "leak": {
      title: "sets a variable in the harness process",
      entryPoint: "node",
      async run(context) {
        process.env.PROBE_LEAK = "leaked";
        const result = await context.command("node exits 0", process.execPath, ["-e", "process.exitCode = 0"]);
        context.expect(result.folder, [exitIs(result, 0)]);
      },
    },
    "peek": {
      title: "fails when it inherits PROBE_LEAK",
      entryPoint: "node",
      async run(context) {
        const result = await context.command("node reads PROBE_LEAK", process.execPath, ["-e", "process.exitCode = process.env.PROBE_LEAK ? 5 : 0"]);
        context.expect(result.folder, [exitIs(result, 0)]);
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
    "unreachable": {
      title: "unreachable",
      entryPoint: "node",
      async run(context) {
        context.notVerified("the sandbox is down");
      },
    },
  },
};
`;

interface Features {
  smoke: string[];
  api: string[];
  docs?: string[];
}

/** A repository whose diff touches `api` only, so its plan runs smoke then api and leaves docs out. */
function repo(t: TestContext, features: Features) {
  const tmp = mkdtempSync(join(tmpdir(), "verify-journeys-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const root = verifyRepo(t, {
    "README.md": "# Demo\n",
    "src/api.ts": "export const api = 1;\n",
    [`${SKILL}/verify.config.ts`]: CONFIG,
    [`${SKILL}/features/smoke.md`]: feature([], features.smoke),
    [`${SKILL}/features/api.md`]: feature(["src/**"], features.api),
    [`${SKILL}/features/docs.md`]: feature(
      ["docs/**"],
      features.docs ?? ["own"],
    ),
  });
  put(root, "src/api.ts", "export const api = 2;\n");
  return { root, tmp, run: newRun(root, tmp) };
}

/** Journey output without the `(x.y s)` time each journey line ends with, so a comparison does not depend on how long a journey took. */
function untimed(stdout: string): string {
  return stdout.replace(/ \(\d+\.\d s\)$/gm, "");
}

function statuses(run: string, name: string): string[] {
  return evidence(run, `${name}/feature.json`).map(
    (result: { journey: string; status: string; reusedFrom?: string }) =>
      `${result.journey} ${result.status} ${result.reusedFrom ?? "-"}`,
  );
}

test("journey --plan runs smoke then the diff's features and merges each feature.json; a loop over every feature file runs docs, and one in file order runs api before smoke", (t) => {
  const { root, tmp, run } = repo(t, {
    smoke: ["own"],
    api: ["bad", "shared"],
  });
  const planned = verify(root, tmp, ["journey", run, "--plan"]);
  assert.equal(planned.status, 1, planned.stderr);
  assert.equal(
    untimed(planned.stdout),
    [
      "PASS smoke/own",
      "FAIL api/bad",
      "    01-node-exits-3: exit code 0 (exit code 3)",
      "PASS api/shared",
      "",
    ].join("\n"),
  );
  assert.equal(ran(run, "docs/own"), false);
  assert.deepEqual(statuses(run, "smoke"), ["own PASS -"]);
  assert.deepEqual(statuses(run, "api"), ["bad FAIL -", "shared PASS -"]);
});

test("journey --plan on a run created with new --all runs every feature; a plan that drops the run's flag skips docs", (t) => {
  const { root, tmp } = repo(t, { smoke: ["own"], api: ["shared"] });
  const full = mkdtempSync(join(tmp, "all-"));
  const created = verify(root, full, ["new", "--all"]);
  assert.equal(created.status, 0, created.stderr);
  const planned = verify(root, full, [
    "journey",
    created.stdout.trim(),
    "--plan",
  ]);
  assert.equal(planned.status, 0, planned.stderr);
  assert.match(untimed(planned.stdout), /^PASS docs\/own/m);
});

test("a failing or unknown feature still lets the next feature run, and the call exits 1; a loop that stops at the first failure, or returns the last feature's code, fails it", (t) => {
  const { root, tmp, run } = repo(t, {
    smoke: ["own"],
    api: ["bad", "unreachable"],
  });
  const result = verify(root, tmp, [
    "journey",
    run,
    "--features",
    "api,nope,smoke",
  ]);
  assert.equal(result.status, 1);
  assert.match(untimed(result.stdout), /^FAIL api\/bad\n/);
  assert.match(
    untimed(result.stdout),
    /^NOT VERIFIED api\/unreachable\n {4}the sandbox is down\nPASS smoke\/own\n$/m,
  );
  assert.equal(result.stderr, "Unknown feature nope: no features/nope.md\n");
  assert.deepEqual(statuses(run, "api"), [
    "bad FAIL -",
    "unreachable NOT VERIFIED -",
  ]);
  assert.deepEqual(statuses(run, "smoke"), ["own PASS -"]);
});

test("journey --plan prints exactly what one call per planned feature prints, and records the same results; a call that runs other features, in another order, or stops at the first failure prints something else", (t) => {
  const features = {
    smoke: ["shared", "unreachable"],
    api: ["shared", "bad", "own"],
  };
  const single = repo(t, features);
  const outputs = ["smoke", "api"].map((name) =>
    verify(single.root, single.tmp, ["journey", single.run, name]),
  );
  const together = repo(t, features);
  const planned = verify(together.root, together.tmp, [
    "journey",
    together.run,
    "--plan",
  ]);
  assert.equal(
    untimed(planned.stdout),
    outputs.map((output) => untimed(output.stdout)).join(""),
  );
  assert.equal(planned.stderr, outputs.map((output) => output.stderr).join(""));
  assert.equal(planned.status, 1);
  for (const name of ["smoke", "api"])
    assert.deepEqual(statuses(together.run, name), statuses(single.run, name));
});

test("a journey two planned features list runs once in one --plan call and the later feature reuses its PASS; running the features at once runs it twice, and a line without the reuse marker hides that it did not run", (t) => {
  const { root, tmp, run } = repo(t, {
    smoke: ["shared"],
    api: ["shared", "own"],
  });
  const planned = verify(root, tmp, ["journey", run, "--plan"]);
  assert.equal(planned.status, 0, planned.stderr);
  assert.equal(
    untimed(planned.stdout),
    "PASS smoke/shared\nPASS api/shared (reuses smoke/shared, not run again)\nPASS api/own\n",
  );
  assert.equal(ran(run, "api/shared"), false);
  assert.equal(ran(run, "api/own"), true);
});

test("after the feature, a positional stays a journey id even when a feature has that name; reading it as a feature runs docs instead of api's docs journey", (t) => {
  const { root, tmp, run } = repo(t, {
    smoke: ["own"],
    api: ["docs", "own"],
    docs: ["bad"],
  });
  const named = verify(root, tmp, ["journey", run, "api", "docs"]);
  assert.equal(named.status, 0, named.stderr);
  assert.equal(untimed(named.stdout), "PASS api/docs\n");
  assert.equal(ran(run, "docs/bad"), false);
  const whole = verify(root, tmp, ["journey", run, "api"]);
  assert.equal(untimed(whole.stdout), "PASS api/docs\nPASS api/own\n");
  const refused = verify(root, tmp, ["journey", run, "api", "bad"]);
  assert.equal(refused.status, 1);
  assert.equal(
    refused.stderr,
    "api registers no journey bad; it registers docs, own\n",
  );
});

test("journey --plan or --features refuses journey ids and each other before anything runs; accepting them silently drops the ids", (t) => {
  const { root, tmp, run } = repo(t, { smoke: ["own"], api: ["own"] });
  for (const args of [
    ["--plan", "api"],
    ["--features", "api", "smoke"],
    ["--plan", "--features", "api"],
    ["--features", ","],
  ]) {
    const refused = verify(root, tmp, ["journey", run, ...args]);
    assert.equal(refused.status, 1, args.join(" "));
    assert.equal(refused.stdout, "", args.join(" "));
    assert.notEqual(refused.stderr, "", args.join(" "));
  }
  assert.equal(ran(run, "smoke/own"), false);
  assert.equal(ran(run, "api/own"), false);
});

test("journey --plan gives each feature the environment its own call would have; a loop that leaves a journey's process.env change in place fails the next feature", (t) => {
  const { root, tmp, run } = repo(t, { smoke: ["leak"], api: ["peek"] });
  const planned = verify(root, tmp, ["journey", run, "--plan"]);
  assert.equal(planned.status, 0, planned.stdout + planned.stderr);
  assert.equal(untimed(planned.stdout), "PASS smoke/leak\nPASS api/peek\n");
});

test("journey --plan names the features left unrun when a journey leaves an uncaught error; a loop with no handler dies with a bare stack trace", (t) => {
  const { root, tmp, run } = repo(t, { smoke: ["timer"], api: ["shared"] });
  const planned = verify(root, tmp, ["journey", run, "--plan"]);
  assert.equal(planned.status, 1);
  assert.match(
    planned.stderr,
    /^smoke: a journey left an uncaught error: async boom\nnot run: api\n$/,
  );
  assert.equal(ran(run, "api/shared"), false);
});

test("journey --features joins repeated flags and trims names; parsing that keeps the last flag drops smoke, and one that keeps spaces calls api unknown", (t) => {
  const { root, tmp, run } = repo(t, { smoke: ["own"], api: ["shared"] });
  const named = verify(root, tmp, [
    "journey",
    run,
    "--features",
    "smoke",
    "--features",
    " api ",
  ]);
  assert.equal(named.status, 0, named.stdout + named.stderr);
  assert.equal(untimed(named.stdout), "PASS smoke/own\nPASS api/shared\n");
});
