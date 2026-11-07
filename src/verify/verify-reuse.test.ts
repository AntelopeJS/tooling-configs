import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { commit, put } from "../guardrails/helpers/test-repo.ts";
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
  doors: ${PUBLISH_DOORS.replace("data: null", `data: { globs: ["src/store.ts"], funnels: [], why: "deletes rows" }`)},
  journeys: {
    ${journey("shared", 0)},
    ${journey("own", 0)},
    ${journey("bad", 3)},
    "flaky": {
      title: "flaky fails once flaky.marker exists",
      entryPoint: "node",
      async run(context) {
        const result = await context.command("node checks the marker", process.execPath, ["-e", "process.exitCode = require('node:fs').existsSync(process.argv[1]) ? 3 : 0", context.repo + "/flaky.marker"]);
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

function repo(t: TestContext, smoke: string[], store: string[]) {
  const tmp = mkdtempSync(join(tmpdir(), "verify-reuse-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const root = verifyRepo(t, {
    "README.md": "# Demo\n",
    "src/store.ts": "export const store = 1;\n",
    [`${SKILL}/verify.config.ts`]: CONFIG,
    [`${SKILL}/features/smoke.md`]: feature([], smoke),
    [`${SKILL}/features/store.md`]: feature(["src/**"], store),
  });
  return { root, tmp, run: newRun(root, tmp) };
}

test("a journey listed under two features runs once and the second feature records a reused PASS that names its source", (t) => {
  const { root, tmp, run } = repo(t, ["shared"], ["shared", "own"]);
  assert.equal(verify(root, tmp, ["journey", run, "smoke"]).status, 0);
  const second = verify(root, tmp, ["journey", run, "store"]);
  assert.equal(second.status, 0, second.stdout);
  assert.match(
    second.stdout,
    /^PASS store\/shared \(reuses smoke\/shared, not run again\)\nPASS store\/own \(\d+\.\d s\)\n$/,
  );
  assert.equal(ran(run, "smoke/shared"), true);
  assert.equal(ran(run, "store/shared"), false);
  assert.equal(ran(run, "store/own"), true);
  const [reused] = evidence(run, "store/feature.json");
  assert.equal(reused.status, "PASS");
  assert.equal(reused.reusedFrom, "smoke/shared");
  assert.equal(reused.folder, "store/shared");
  assert.equal(
    evidence(run, "store/shared/result.json").reusedFrom,
    "smoke/shared",
  );
  assert.equal(evidence(run, "smoke/feature.json")[0].reusedFrom, undefined);
  assert.ok((evidence(run, "smoke/feature.json")[0].ms ?? 0) > 0);
  assert.equal(reused.ms, 0);
  assert.deepEqual(reused.stepMs, []);
});

test("a FAIL or NOT VERIFIED result is never reused: the second feature runs the journey itself", (t) => {
  const { root, tmp, run } = repo(
    t,
    ["bad", "unreachable"],
    ["bad", "unreachable"],
  );
  assert.equal(verify(root, tmp, ["journey", run, "smoke"]).status, 1);
  const second = verify(root, tmp, ["journey", run, "store"]);
  assert.match(second.stdout, /^FAIL store\/bad \(\d+\.\d s\)\n/m);
  assert.match(
    second.stdout,
    /^NOT VERIFIED store\/unreachable \(\d+\.\d s\)\n/m,
  );
  assert.equal(ran(run, "store/bad"), true);
  for (const result of evidence(run, "store/feature.json"))
    assert.equal(result.reusedFrom, undefined);
});

test("a run whose HEAD moved after it was created never reuses a PASS", (t) => {
  const { root, tmp, run } = repo(t, ["shared"], ["shared"]);
  assert.equal(verify(root, tmp, ["journey", run, "smoke"]).status, 0);
  put(root, "README.md", "# Demo, edited\n");
  commit(root);
  const second = verify(root, tmp, ["journey", run, "store"]);
  assert.equal(second.status, 0, second.stdout);
  assert.match(second.stdout, /^PASS store\/shared \(\d+\.\d s\)\n$/);
  assert.equal(ran(run, "store/shared"), true);
});

test("naming the journey runs it even when another feature already passed it", (t) => {
  const { root, tmp, run } = repo(t, ["shared"], ["shared"]);
  assert.equal(verify(root, tmp, ["journey", run, "smoke"]).status, 0);
  const forced = verify(root, tmp, ["journey", run, "store", "shared"]);
  assert.match(forced.stdout, /^PASS store\/shared \(\d+\.\d s\)\n$/);
  assert.equal(ran(run, "store/shared"), true);
  assert.equal(evidence(run, "store/feature.json")[0].reusedFrom, undefined);
});

test("a feature that already has a result for a journey runs it again instead of reusing another feature's PASS", (t) => {
  const { root, tmp, run } = repo(t, ["shared"], ["shared"]);
  assert.equal(
    verify(root, tmp, ["journey", run, "store", "shared"]).status,
    0,
  );
  assert.equal(verify(root, tmp, ["journey", run, "smoke"]).status, 0);
  const again = verify(root, tmp, ["journey", run, "store"]);
  assert.match(again.stdout, /^PASS store\/shared \(\d+\.\d s\)\n$/);
  assert.equal(ran(run, "store/shared"), true);
});

test("the verdict still requires every registered journey and marks each reused one with its source", (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "verify-reuse-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const root = verifyRepo(t, {
    "README.md": "# Demo\n",
    "src/store.ts": "export const store = 1;\n",
    [`${SKILL}/verify.config.ts`]: CONFIG,
    [`${SKILL}/features/smoke.md`]: feature([], ["shared"]),
    [`${SKILL}/features/store.md`]: feature(["src/**"], ["shared"]),
  });
  put(root, "src/store.ts", "export const store = 2;\n");
  const run = newRun(root, tmp);
  put(
    run,
    "evidence/judgement.json",
    JSON.stringify({
      doors: {
        rows: [
          {
            kind: "data",
            location: "src/store.ts",
            irreversible: "rows deleted",
            containment: "dry run",
          },
        ],
      },
      docs: [{ page: "README.md", matches: true }],
      verifier: "a fresh thread",
    }),
  );
  assert.equal(verify(root, tmp, ["journey", run, "smoke"]).status, 0);
  const missing = verify(root, tmp, ["verdict", run, "--pr", "7"]);
  assert.equal(missing.status, 1);
  assert.match(missing.stdout, /- store\/shared was not run\n/);
  assert.equal(verify(root, tmp, ["journey", run, "store"]).status, 0);
  const passed = verify(root, tmp, ["verdict", run, "--pr", "7"]);
  assert.equal(passed.status, 0, passed.stdout);
  assert.match(passed.stdout, /^## Verify: PASS\n/);
  assert.match(
    passed.stdout,
    /\| store \| `shared`: node \| pass: shared exits 0 \(not run again: reuses \[smoke\/shared\]\(https:\/\/github\.com\/acme\/demo\/tree\/verify-evidence\/pr-7\/[0-9a-f]{40}\/smoke\/shared\)\) \| \[store\/shared\]\(/,
  );
});

const DATA_JUDGEMENT = JSON.stringify({
  doors: {
    rows: [
      {
        kind: "data",
        location: "src/store.ts",
        irreversible: "rows deleted",
        containment: "dry run",
      },
    ],
  },
  docs: [{ page: "README.md", matches: true }],
  verifier: "a fresh thread",
});

test("an uncommitted edit after the source ran is a new tree, so the journey runs again; reuse keyed on HEAD alone would keep a stale PASS", (t) => {
  const { root, tmp, run } = repo(t, ["shared"], ["shared"]);
  assert.equal(verify(root, tmp, ["journey", run, "smoke"]).status, 0);
  put(root, "src/store.ts", "export const store = 2;\n");
  const second = verify(root, tmp, ["journey", run, "store"]);
  assert.equal(second.status, 0, second.stdout);
  assert.match(second.stdout, /^PASS store\/shared \(\d+\.\d s\)\n$/);
  assert.equal(ran(run, "store/shared"), true);
});

test("a reused PASS whose source later fails makes the verdict name the stale reuse; a verdict that trusts the copied status shows a pass", (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "verify-reuse-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const root = verifyRepo(t, {
    "README.md": "# Demo\n",
    "src/store.ts": "export const store = 1;\n",
    [`${SKILL}/verify.config.ts`]: CONFIG,
    [`${SKILL}/features/smoke.md`]: feature([], ["flaky"]),
    [`${SKILL}/features/store.md`]: feature(["src/**"], ["flaky"]),
  });
  put(root, "src/store.ts", "export const store = 2;\n");
  const run = newRun(root, tmp);
  put(run, "evidence/judgement.json", DATA_JUDGEMENT);
  assert.equal(verify(root, tmp, ["journey", run, "smoke"]).status, 0);
  assert.match(
    verify(root, tmp, ["journey", run, "store"]).stdout,
    /reuses smoke\/flaky/,
  );
  put(root, "flaky.marker", "");
  assert.equal(verify(root, tmp, ["journey", run, "smoke", "flaky"]).status, 1);
  const verdict = verify(root, tmp, ["verdict", run, "--pr", "7"]);
  assert.equal(verdict.status, 1);
  assert.match(
    verdict.stdout,
    /- store\/flaky reuses smoke\/flaky, which is now FAIL\n/,
  );
});

test("untracked entries git lists oddly, a non-ASCII name, symlinks to a folder or to nothing and a nested repository, never stop a journey; a fingerprint that reads every untracked path as a file crashes", (t) => {
  const { root, tmp, run } = repo(t, ["shared"], ["shared"]);
  assert.equal(verify(root, tmp, ["journey", run, "smoke"]).status, 0);
  put(root, "café.txt", "x\n");
  symlinkSync("src", join(root, "linkdir"));
  symlinkSync("nowhere", join(root, "dangling"));
  mkdirSync(join(root, "nested"));
  execFileSync("git", ["init", "-q"], { cwd: join(root, "nested") });
  put(root, "nested/a.txt", "a\n");
  const second = verify(root, tmp, ["journey", run, "store"]);
  assert.equal(second.status, 0, second.stdout + second.stderr);
  assert.match(second.stdout, /^PASS store\/shared \(\d+\.\d s\)\n$/);
});

test("a run folder inside the repository is left out of the tree, so its own evidence never blocks reuse; hashing it reruns every journey", (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "verify-reuse-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const root = verifyRepo(t, {
    "README.md": "# Demo\n",
    "src/store.ts": "export const store = 1;\n",
    [`${SKILL}/verify.config.ts`]: CONFIG,
    [`${SKILL}/features/smoke.md`]: feature([], ["shared"]),
    [`${SKILL}/features/store.md`]: feature(["src/**"], ["shared"]),
  });
  const inside = join(root, "tmp");
  mkdirSync(inside);
  const run = newRun(root, inside);
  assert.equal(verify(root, inside, ["journey", run, "smoke"]).status, 0);
  const second = verify(root, inside, ["journey", run, "store"]);
  assert.equal(second.status, 0, second.stdout);
  assert.match(second.stdout, /reuses smoke\/shared, not run again/);
});

test("an untracked nested repository turns reuse off, since an edit inside it leaves its folder's time alone; fingerprinting the folder alone reuses a stale PASS", (t) => {
  const { root, tmp, run } = repo(t, ["shared"], ["shared"]);
  mkdirSync(join(root, "nested"));
  execFileSync("git", ["init", "-q"], { cwd: join(root, "nested") });
  put(root, "nested/a.txt", "a\n");
  assert.equal(verify(root, tmp, ["journey", run, "smoke"]).status, 0);
  put(root, "nested/a.txt", "changed content, longer\n");
  const second = verify(root, tmp, ["journey", run, "store"]);
  assert.equal(second.status, 0, second.stdout);
  assert.match(second.stdout, /^PASS store\/shared \(\d+\.\d s\)\n$/);
});
