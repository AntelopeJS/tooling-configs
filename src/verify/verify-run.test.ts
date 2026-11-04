import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
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
import { judgeSeeded } from "./seeded.ts";

const SKILL = ".agents/skills/verify-module";

function journey(id: string, code: number, expected = 0): string {
  return `${JSON.stringify(id)}: {
      title: "${id} exits ${code}",
      entryPoint: "node",
      async run(context) {
        const result = await context.command("node exits ${code}", process.execPath, ["-e", "process.exitCode = ${code}"]);
        context.expect(result.folder, [exitIs(result, ${expected})]);
      },
    }`;
}

function config(extra = ""): string {
  return `import { exitIs } from ${JSON.stringify(CHECKS)};
export default {
  doors: ${PUBLISH_DOORS.replace("data: null", `data: { globs: ["src/store.ts"], funnels: [], containments: ["store/kept"], why: "deletes rows" }`)},
  journeys: {
    ${journey("ok", 0)},
    ${journey("bad", 3)},
    ${journey("kept", 0)},
    "unreachable": {
      title: "unreachable",
      entryPoint: "node",
      async run(context) {
        context.notVerified("the sandbox is down");
      },
    },
  },
  ${extra}
};
`;
}

function runRepo(t: TestContext, extra = "") {
  const tmp = mkdtempSync(join(tmpdir(), "verify-runs-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const root = verifyRepo(t, {
    "README.md": "# Demo\n",
    "src/store.ts": "export const store = 1;\n",
    [`${SKILL}/verify.config.ts`]: config(extra),
    [`${SKILL}/features/smoke.md`]: feature([], ["ok"]),
    [`${SKILL}/features/store.md`]: feature(["src/**"], ["ok", "kept"]),
  });
  return { root, tmp };
}

function judgement(run: string, value: Judged): void {
  put(run, "evidence/judgement.json", JSON.stringify(value));
}

/** The parts of judgement.json these tests write. */
interface Judged {
  doors: { none?: string; rows?: { [field: string]: string }[] };
  docs: { page: string; matches: boolean; note?: string }[];
  notVerified?: string[];
  attention?: string[];
  verifier: string;
}

const JUDGED: Judged = {
  doors: { none: "no door" },
  docs: [{ page: "README.md", matches: true }],
  verifier: "a fresh thread",
};

test("journey records PASS and FAIL from the checks and merges partial runs into feature.json", (t) => {
  const { root, tmp } = runRepo(t);
  put(root, `${SKILL}/features/store.md`, feature(["src/**"], ["ok", "bad"]));
  const run = newRun(root, tmp);
  const first = verify(root, tmp, ["journey", run, "store", "bad"]);
  assert.equal(first.status, 1);
  assert.match(
    first.stdout,
    /^FAIL store\/bad\n {4}01-node-exits-3: exit code 0 \(exit code 3\)/m,
  );
  const second = verify(root, tmp, ["journey", run, "store", "ok"]);
  assert.equal(second.status, 0, second.stdout);
  const merged = evidence(run, "store/feature.json");
  assert.deepEqual(
    merged.map(
      (result: { journey: string; status: string }) =>
        `${result.journey} ${result.status}`,
    ),
    ["ok PASS", "bad FAIL"],
  );
  assert.equal(
    read(run, "evidence/store/bad/01-node-exits-3/exit-code.txt"),
    "3\n",
  );
});

test("a journey a feature does not register is refused before anything runs", (t) => {
  const { root, tmp } = runRepo(t);
  const run = newRun(root, tmp);
  const result = verify(root, tmp, ["journey", run, "store", "bad"]);
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /store registers no journey bad; it registers ok, kept/,
  );
  assert.equal(existsSync(join(run, "evidence/store")), false);
});

test("missing sandbox keys make every journey NOT VERIFIED without running it, and the verdict too", (t) => {
  const { root, tmp } = runRepo(
    t,
    `saas: { env: ["DEMO_SANDBOX_KEY"], sandbox: "demo" },`,
  );
  const run = newRun(root, tmp);
  const smoke = verify(root, tmp, ["journey", run, "smoke"]);
  assert.equal(smoke.status, 1);
  assert.match(
    smoke.stdout,
    /NOT VERIFIED smoke\/ok\n {4}provider sandbox keys missing from the environment: DEMO_SANDBOX_KEY/,
  );
  assert.equal(
    existsSync(join(run, "evidence/smoke/ok/01-node-exits-0")),
    false,
  );
  judgement(run, JUDGED);
  const verdict = verify(root, tmp, ["verdict", run, "--pr", "7"]);
  assert.equal(verdict.status, 1, verdict.stderr);
  assert.match(verdict.stdout, /^## Verify: NOT VERIFIED\n/);
});

test("notes never soften a NOT VERIFIED journey, and stay PASS+NOTES when every required journey passed", (t) => {
  const keyed = runRepo(
    t,
    `saas: { env: ["DEMO_SANDBOX_KEY"], sandbox: "demo" },`,
  );
  const unverified = newRun(keyed.root, keyed.tmp);
  verify(keyed.root, keyed.tmp, ["journey", unverified, "smoke"]);
  judgement(unverified, {
    ...JUDGED,
    notVerified: ["a note"],
    attention: ["look here"],
  });
  const blocked = verify(keyed.root, keyed.tmp, [
    "verdict",
    unverified,
    "--pr",
    "7",
  ]);
  assert.match(blocked.stdout, /^## Verify: NOT VERIFIED\n/);
  const { root, tmp } = runRepo(t);
  const run = newRun(root, tmp);
  verify(root, tmp, ["journey", run, "smoke"]);
  judgement(run, {
    ...JUDGED,
    notVerified: ["a note"],
  });
  const noted = verify(root, tmp, ["verdict", run, "--pr", "7"]);
  assert.equal(noted.status, 0, noted.stderr);
  assert.match(noted.stdout, /^## Verify: PASS\+NOTES\n/);
});

test("a verdict without a One-way doors section or a verifier is void", (t) => {
  const { root, tmp } = runRepo(t);
  const run = newRun(root, tmp);
  judgement(run, { ...JUDGED, doors: {} });
  const noDoors = verify(root, tmp, ["verdict", run, "--pr", "7"]);
  assert.equal(noDoors.status, 1);
  assert.match(noDoors.stderr, /a verdict without it is void/);
  judgement(run, { ...JUDGED, verifier: "" });
  const noVerifier = verify(root, tmp, ["verdict", run, "--pr", "7"]);
  assert.equal(noVerifier.status, 1);
  assert.match(noVerifier.stderr, /verifier must say who judged this run/);
});

test("the verdict passes only when every registered journey ran and passed, with the doors section right after the result", (t) => {
  const { root, tmp } = runRepo(t);
  const run = newRun(root, tmp);
  assert.equal(verify(root, tmp, ["journey", run, "smoke"]).status, 0);
  judgement(run, JUDGED);
  const passed = verify(root, tmp, ["verdict", run, "--pr", "7"]);
  assert.equal(passed.status, 0, passed.stderr);
  assert.match(
    passed.stdout,
    /^## Verify: PASS\n\n### One-way doors\nNone: no door\n/,
  );
  assert.match(
    passed.stdout,
    /\| smoke \| `ok`: node \| pass: ok exits 0 \| \[smoke\/ok\]\(https:\/\/github\.com\/acme\/demo\/tree\/verify-evidence\/pr-7\/[0-9a-f]{40}\/smoke\/ok\) \|/,
  );
  put(root, "src/store.ts", "export const store = 2;\n");
  const changed = verify(root, tmp, ["verdict", run, "--pr", "7"]);
  assert.equal(changed.status, 1);
  assert.match(changed.stdout, /^## Verify: FAIL\n/);
  assert.match(
    changed.stdout,
    /- store\/ok was not run\n- store\/kept was not run\n/,
  );
  assert.match(
    changed.stdout,
    /- path rules flag a data door at src\/store\.ts/,
  );
});

test("a journey that failed outside the diff's features fails the verdict, even when an unrun journey sits beside it", (t) => {
  const { root, tmp } = runRepo(t);
  put(
    root,
    `${SKILL}/features/store.md`,
    feature(["src/**"], ["ok", "bad", "kept"]),
  );
  const run = newRun(root, tmp);
  assert.equal(verify(root, tmp, ["journey", run, "smoke"]).status, 0);
  assert.equal(verify(root, tmp, ["journey", run, "store", "ok"]).status, 0);
  judgement(run, JUDGED);
  const passed = verify(root, tmp, ["verdict", run, "--pr", "7"]);
  assert.equal(passed.status, 0, passed.stderr);
  assert.match(passed.stdout, /^## Verify: PASS\n/);
  assert.deepEqual(evidence(run, "plan.json").run, ["smoke"]);
  assert.match(
    passed.stdout,
    /\| store \(outside the diff's features\) \| `ok`: node \| pass: /,
  );
  assert.equal(verify(root, tmp, ["journey", run, "store", "bad"]).status, 1);
  const failed = verify(root, tmp, ["verdict", run, "--pr", "7"]);
  assert.equal(failed.status, 1);
  assert.match(failed.stdout, /^## Verify: FAIL\n/);
  assert.match(
    failed.stdout,
    /### Why it fails\n- store\/bad failed; store is outside the diff's features, so check its covers globs\n\n/,
  );
  assert.match(
    failed.stdout,
    /\| store \(outside the diff's features\) \| `bad`: node \| \*\*fail\*\*: /,
  );
  assert.deepEqual(evidence(run, "verdict.json").reasons, [
    "store/bad failed; store is outside the diff's features, so check its covers globs",
  ]);
  assert.equal(evidence(run, "verdict.json").result, "FAIL");
});

test("a NOT VERIFIED journey outside the diff's features is listed and downgrades PASS, and never hides a FAIL beside it", (t) => {
  const { root, tmp } = runRepo(t);
  put(
    root,
    `${SKILL}/features/store.md`,
    feature(["src/**"], ["bad", "unreachable"]),
  );
  const run = newRun(root, tmp);
  assert.equal(verify(root, tmp, ["journey", run, "smoke"]).status, 0);
  assert.equal(
    verify(root, tmp, ["journey", run, "store", "unreachable"]).status,
    1,
  );
  judgement(run, JUDGED);
  const noted = verify(root, tmp, ["verdict", run, "--pr", "7"]);
  assert.equal(noted.status, 0, noted.stderr);
  assert.match(noted.stdout, /^## Verify: PASS\+NOTES\n/);
  assert.match(
    noted.stdout,
    /### Not verified\n- store\/unreachable: the sandbox is down\n/,
  );
  assert.equal(verify(root, tmp, ["journey", run, "store", "bad"]).status, 1);
  const failed = verify(root, tmp, ["verdict", run, "--pr", "7"]);
  assert.equal(failed.status, 1);
  assert.match(failed.stdout, /^## Verify: FAIL\n/);
  assert.match(failed.stdout, /- store\/bad failed; store is outside/);
  assert.match(
    failed.stdout,
    /### Not verified\n- store\/unreachable: the sandbox is down\n/,
  );
});

test("a flagged door needs a row or a reasoned false positive, and a Data row needs its containment journey passing", (t) => {
  const { root, tmp } = runRepo(t);
  put(root, "src/store.ts", "export const store = 2;\n");
  const run = newRun(root, tmp);
  assert.equal(verify(root, tmp, ["journey", run, "smoke"]).status, 0);
  assert.equal(verify(root, tmp, ["journey", run, "store", "ok"]).status, 0);
  judgement(run, JUDGED);
  const unlisted = verify(root, tmp, ["verdict", run, "--pr", "7"]);
  assert.match(
    unlisted.stdout,
    /path rules flag a data door at src\/store\.ts that the One-way doors section neither lists nor dismisses/,
  );
  const row = {
    kind: "data",
    location: "src/store.ts",
    irreversible: "rows deleted",
    containment: "dry run",
    containmentJourney: "store/kept",
  };
  judgement(run, { ...JUDGED, doors: { rows: [row] } });
  const uncontained = verify(root, tmp, ["verdict", run, "--pr", "7"]);
  assert.match(
    uncontained.stdout,
    /data door at src\/store\.ts: containment journey store\/kept did not pass in this run/,
  );
  assert.equal(verify(root, tmp, ["journey", run, "store", "kept"]).status, 0);
  const contained = verify(root, tmp, ["verdict", run, "--pr", "7"]);
  assert.equal(contained.status, 0, contained.stdout);
  assert.match(
    contained.stdout,
    /^## Verify: PASS\n\n### One-way doors\n\| Kind \| Location/,
  );
  judgement(run, {
    ...JUDGED,
    doors: { rows: [row] },
    docs: [{ page: "README.md", matches: false, note: "says 1" }],
  });
  const stale = verify(root, tmp, ["verdict", run, "--pr", "7"]);
  assert.equal(stale.status, 1);
  assert.match(stale.stdout, /- README\.md no longer matches the behaviour/);
});

test("clean keeps the evidence and run.json and removes the scratch folders", (t) => {
  const { root, tmp } = runRepo(t);
  const run = newRun(root, tmp);
  assert.equal(verify(root, tmp, ["journey", run, "smoke"]).status, 0);
  assert.equal(existsSync(join(run, "work/smoke/ok")), true);
  const cleaned = verify(root, tmp, ["clean", run]);
  assert.equal(cleaned.status, 0, cleaned.stderr);
  assert.equal(cleaned.stdout, "");
  assert.equal(existsSync(join(run, "work")), false);
  assert.equal(existsSync(join(run, "homes")), false);
  assert.equal(
    read(run, "evidence/smoke/ok/01-node-exits-0/exit-code.txt"),
    "0\n",
  );
  assert.equal(evidence(run, "../run.json").containers.length, 0);
});

function result(
  journey: string,
  status: "PASS" | "FAIL" | "NOT VERIFIED",
  failing: boolean,
) {
  const checks = [{ name: "check", pass: !failing, detail: "" }];
  return {
    feature: "f",
    journey,
    title: "",
    entryPoint: "",
    status,
    steps: [{ name: "s", folder: "", checks }],
    error: null,
    notVerified: status === "NOT VERIFIED" ? "the service went away" : null,
    folder: "",
  };
}

test("a seeded break counts only through a journey that passes in the control and fails a check with the patch", () => {
  const control = {
    run: "c",
    output: "",
    results: [
      result("a", "PASS", false),
      result("b", "FAIL", true),
      result("c", "PASS", false),
    ],
  };
  const seeded = {
    run: "s",
    output: "",
    results: [
      result("a", "PASS", false),
      result("b", "FAIL", true),
      result("c", "FAIL", false),
    ],
  };
  const missed = judgeSeeded("f", control, seeded);
  assert.equal(missed.outcome, "MISSED");
  assert.deepEqual(missed.failingInControl, ["b"]);
  assert.deepEqual(missed.harnessErrors, ["c"]);
  seeded.results[0] = result("a", "FAIL", true);
  const caught = judgeSeeded("f", control, seeded);
  assert.equal(caught.outcome, "CAUGHT");
  assert.deepEqual(caught.caughtBy, ["a"]);
  seeded.results[0] = result("a", "NOT VERIFIED", true);
  const unreached = judgeSeeded("f", control, seeded);
  assert.equal(unreached.outcome, "NOT VERIFIED");
  assert.deepEqual(unreached.caughtBy, []);
  assert.deepEqual(unreached.notVerified.seeded, ["a (the service went away)"]);
});
