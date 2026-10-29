import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { commit, put, read } from "../guardrails/helpers/test-repo.ts";
import {
  feature,
  newRun,
  PUBLISH_DOORS,
  verify,
  verifyRepo,
} from "./helpers/verify-repo.ts";

const SKILL = ".agents/skills/verify-module";
const ADD = "export function add(a, b) {\n  return a + b;\n}\n";
const OPS =
  'export const label = "ops";\nexport const mark = label.toUpperCase();\n';

/** A model-like check: it prints the same rule names whatever the code looks like, as long as it behaves the same. */
const CHECK = `import { join } from "node:path";
import { pathToFileURL } from "node:url";
const { add } = await import(pathToFileURL(join(process.cwd(), "src/math.js")).href);
if (add(1, 2) !== 3) {
  console.log("BROKEN AddWorks");
  process.exitCode = 1;
} else console.log("holds AddWorks");
if (Object.is(add(-0, -0), -0)) console.log("finding NegativeZero");
else console.log("holds NegativeZero");
`;

/** The same check after a rewrite that no longer reports the NegativeZero rule at all. */
const CHECK_WITHOUT_RULE = CHECK.replace(/if \(Object\.is[\s\S]*$/, "");

const CONFIG = `export default {
  doors: ${PUBLISH_DOORS},
  formal: [
    {
      name: "formal-add",
      covers: ["src/math.js", "src/ops.js", "src/typed.ts"],
      files: [".agents/skills/formal-add/**"],
      command: ["node", ".agents/skills/formal-add/check.mjs"],
      violation: /^(?:finding|BROKEN) (\\w+)/gm,
      passing: /^holds (\\w+)/gm,
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
    "src/typed.ts":
      "export const total = [1, 2, 3].reduce((sum, n) => sum + n, 0);\n",
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

test("reordering the statements of a covered file fails, though the same statements remain", (t) => {
  const { root, tmp, run } = formalRepo(t, {
    "src/ops.js":
      'export const mark = label.toUpperCase();\nexport const label = "ops";\n',
  });
  const formal = verify(root, tmp, ["formal", run]);
  assert.equal(formal.status, 1);
  assert.equal(
    formal.stdout,
    "FAIL formal-add: covered behaviour changed (emit), violated NegativeZero\n",
  );
});

test("moving a statement to the top level of another covered file fails", (t) => {
  const { root, tmp, run } = formalRepo(t, {
    "src/ops.js": "export const mark = label.toUpperCase();\n",
    "src/math.js": `export const label = "ops";\n${ADD}`,
  });
  const formal = verify(root, tmp, ["formal", run]);
  assert.equal(formal.status, 1);
  assert.equal(
    formal.stdout,
    "FAIL formal-add: covered behaviour changed (emit), violated NegativeZero\n",
  );
});

test("a reformat with redundant parentheses, other quotes and other line breaks keeps the recorded finding as known", (t) => {
  const { root, tmp, run } = formalRepo(t, {
    "src/math.js":
      "export function add(\n  a,\n  b,\n) {\n  return (a + b);\n}\n",
    "src/ops.js":
      "export const label = ('ops');\nexport const mark =\n  label.toUpperCase();\n",
  });
  const formal = verify(root, tmp, ["formal", run]);
  assert.equal(formal.status, 0, formal.stdout + formal.stderr);
  assert.equal(
    formal.stdout,
    "PASS formal-add: covered behaviour unchanged (emit): known findings NegativeZero\n",
  );
});

test("a type-only edit that the formatter reflows keeps the recorded finding as known", (t) => {
  const { root, tmp, run } = formalRepo(t, {
    "src/typed.ts":
      "export const total: Readonly<Record<string, number>>[number] = [\n  1, 2, 3,\n].reduce(\n  (sum: number, n: number) => sum + n,\n  0,\n);\n",
  });
  const formal = verify(root, tmp, ["formal", run]);
  assert.equal(formal.status, 0, formal.stdout + formal.stderr);
  assert.equal(
    formal.stdout,
    "PASS formal-add: covered behaviour unchanged (emit): known findings NegativeZero\n",
  );
});

test("a rule the base broke that the check no longer reports at all fails instead of counting as fixed", (t) => {
  const { root, tmp, run } = formalRepo(t, {
    "src/math.js": ADD.replace("a + b", "a + b + 0"),
    ".agents/skills/formal-add/check.mjs": CHECK_WITHOUT_RULE,
  });
  const formal = verify(root, tmp, ["formal", run]);
  assert.equal(formal.status, 1);
  assert.equal(
    formal.stdout,
    "FAIL formal-add: rules the base broke are absent at HEAD: NegativeZero\n",
  );
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

function formalResult(run: string) {
  return JSON.parse(read(run, "evidence/formal/formal-add/result.json"));
}

test("a rule counts as fixed only when HEAD reports it passing, never when HEAD drops it", (t) => {
  const fixed = formalRepo(t, {
    "src/math.js": ADD.replace("a + b", "a + b + 0"),
  });
  verify(fixed.root, fixed.tmp, ["formal", fixed.run]);
  assert.deepEqual(formalResult(fixed.run).fixed, ["NegativeZero"]);
  assert.deepEqual(formalResult(fixed.run).missing, []);
  const dropped = formalRepo(t, {
    "src/math.js": ADD.replace("a + b", "a + b + 0"),
    ".agents/skills/formal-add/check.mjs": CHECK_WITHOUT_RULE,
  });
  verify(dropped.root, dropped.tmp, ["formal", dropped.run]);
  assert.deepEqual(formalResult(dropped.run).fixed, []);
  assert.deepEqual(formalResult(dropped.run).missing, ["NegativeZero"]);
});

test("a diff that touches only a check's own files runs the check and gates it against the base", (t) => {
  const { root, tmp, run } = formalRepo(t, {
    ".agents/skills/formal-add/check.mjs": CHECK_WITHOUT_RULE,
  });
  const formal = verify(root, tmp, ["formal", run]);
  assert.equal(formal.status, 1);
  assert.equal(
    formal.stdout,
    "FAIL formal-add: rules the base broke are absent at HEAD: NegativeZero\n",
  );
  assert.match(
    judged(root, tmp, run),
    /- formal check formal-add: rules the base broke are absent at HEAD: NegativeZero\n/,
  );
});
