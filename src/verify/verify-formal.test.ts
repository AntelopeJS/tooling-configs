import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { commit, put } from "../guardrails/helpers/test-repo.ts";
import {
  feature,
  newRun,
  PUBLISH_DOORS,
  verify,
  verifyRepo,
} from "./helpers/verify-repo.ts";

const SKILL = ".agents/skills/verify-module";
const ADD = "export function add(a, b) {\n  return a + b;\n}\n";
const OPS = 'export const label = "ops";\n';

/** A model-like check: it prints the same rule names whatever the code looks like, as long as it behaves the same. */
const CHECK = `import { join } from "node:path";
import { pathToFileURL } from "node:url";
const { add } = await import(pathToFileURL(join(process.cwd(), "src/math.js")).href);
if (add(1, 2) !== 3) {
  console.log("BROKEN AddWorks");
  process.exitCode = 1;
}
if (Object.is(add(-0, -0), -0)) console.log("finding NegativeZero");
`;

const CONFIG = `export default {
  doors: ${PUBLISH_DOORS},
  formal: [
    {
      name: "formal-add",
      covers: ["src/math.js", "src/ops.js"],
      command: ["node", ".agents/skills/formal-add/check.mjs"],
      violation: /^(?:finding|BROKEN) (\\w+)/gm,
    },
  ],
};
`;

function formalRepo(t: TestContext, head: Record<string, string>) {
  const tmp = mkdtempSync(join(tmpdir(), "verify-runs-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const root = verifyRepo(t, {
    "README.md": "# Demo\n",
    "src/math.js": ADD,
    "src/ops.js": OPS,
    ".agents/skills/formal-add/check.mjs": CHECK,
    [`${SKILL}/verify.config.ts`]: CONFIG,
    [`${SKILL}/features/smoke.md`]: feature([], ["module-dev"]),
    [`${SKILL}/features/math.md`]: feature(["src/**"], ["module-dev"]),
  });
  for (const [path, content] of Object.entries(head)) put(root, path, content);
  commit(root);
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
  return verify(root, tmp, ["verdict", run, "--pr", "7"]).stdout;
}

test("a verbatim move of covered code keeps its recorded finding as known and does not fail", (t) => {
  const { root, tmp, run } = formalRepo(t, {
    "src/math.js": 'export { add } from "./ops.js";\n',
    "src/ops.js": `${OPS}${ADD}`,
  });
  const formal = verify(root, tmp, ["formal", run]);
  assert.equal(formal.status, 0, formal.stdout + formal.stderr);
  assert.equal(
    formal.stdout,
    "PASS formal-add: covered behaviour unchanged (emit): known findings NegativeZero\n",
  );
  const verdict = judged(root, tmp, run);
  assert.match(
    verdict,
    /`formal-add` \(covers the diff, gates the verdict\): covered behaviour unchanged \(emit\): known findings NegativeZero\./,
  );
  assert.doesNotMatch(verdict, /- formal check formal-add/);
});

test("a seeded behaviour change that breaks a rule fails, whatever the base reported", (t) => {
  const { root, tmp, run } = formalRepo(t, {
    "src/math.js": ADD.replace("a + b", "a - b"),
  });
  const formal = verify(root, tmp, ["formal", run]);
  assert.equal(formal.status, 1);
  assert.equal(
    formal.stdout,
    "FAIL formal-add: the check no longer matches its record: AddWorks, exit 1\n",
  );
});

test("a changed behaviour fails on its recorded finding even when the check prints the same rule names as the base", (t) => {
  const { root, tmp, run } = formalRepo(t, {
    "src/math.js": ADD.replace("a + b", "b + a"),
  });
  const formal = verify(root, tmp, ["formal", run]);
  assert.equal(formal.status, 1);
  assert.equal(
    formal.stdout,
    "FAIL formal-add: covered behaviour changed (emit), violated NegativeZero\n",
  );
  assert.match(
    judged(root, tmp, run),
    /- formal check formal-add: covered behaviour changed \(emit\), violated NegativeZero\n/,
  );
});

test("a change that fixes a recorded finding passes and names it as fixed against the base", (t) => {
  const { root, tmp, run } = formalRepo(t, {
    "src/math.js": ADD.replace("a + b", "a + b + 0"),
  });
  const formal = verify(root, tmp, ["formal", run]);
  assert.equal(formal.status, 0, formal.stdout + formal.stderr);
  assert.equal(
    formal.stdout,
    "PASS formal-add: covered behaviour changed (emit), no violated rule; fixed: NegativeZero\n",
  );
});

test("a covered check whose run did not compare behaviour with the base fails the verdict", (t) => {
  const { root, tmp, run } = formalRepo(t, {
    "src/math.js": `${ADD}// a comment\n`,
  });
  const all = verify(root, tmp, ["formal", run, "--all"]);
  assert.equal(all.status, 0, all.stderr);
  assert.equal(
    all.stdout,
    "PASS formal-add: covered behaviour unchanged (emit): known findings NegativeZero\n",
  );
  put(
    run,
    "evidence/formal/formal-add/result.json",
    JSON.stringify({
      name: "formal-add",
      exitCode: 0,
      violated: [],
      folder: "formal/formal-add",
    }),
  );
  assert.match(
    judged(root, tmp, run),
    /- formal check formal-add covers the diff but its run did not compare the covered behaviour with the base\n/,
  );
});
