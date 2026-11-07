import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
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
    /^PASS store\/shared \(reuses smoke\/shared, not run again\)\nPASS store\/own\n$/,
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
  assert.equal(reused.ms, undefined);
});

test("a FAIL or NOT VERIFIED result is never reused: the second feature runs the journey itself", (t) => {
  const { root, tmp, run } = repo(
    t,
    ["bad", "unreachable"],
    ["bad", "unreachable"],
  );
  assert.equal(verify(root, tmp, ["journey", run, "smoke"]).status, 1);
  const second = verify(root, tmp, ["journey", run, "store"]);
  assert.match(second.stdout, /^FAIL store\/bad\n/m);
  assert.match(second.stdout, /^NOT VERIFIED store\/unreachable\n/m);
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
  assert.equal(second.stdout, "PASS store/shared\n");
  assert.equal(ran(run, "store/shared"), true);
});

test("naming the journey runs it even when another feature already passed it", (t) => {
  const { root, tmp, run } = repo(t, ["shared"], ["shared"]);
  assert.equal(verify(root, tmp, ["journey", run, "smoke"]).status, 0);
  const forced = verify(root, tmp, ["journey", run, "store", "shared"]);
  assert.equal(forced.stdout, "PASS store/shared\n");
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
  assert.equal(again.stdout, "PASS store/shared\n");
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
