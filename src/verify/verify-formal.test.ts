import assert from "node:assert/strict";
import test from "node:test";

import { put, read } from "../guardrails/helpers/test-repo.ts";
import {
  ADD,
  CHECK,
  CHECK_WITHOUT_RULE,
  OPS,
  formalRepo,
  judged,
} from "./helpers/formal-repo.ts";
import { evidence, verify } from "./helpers/verify-repo.ts";

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

test("an injected behaviour change that breaks a rule fails, whatever the base reported", (t) => {
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

test("a formal check's time covers its head and base runs and shows in the verdict, and `not measured` when the result predates timings; timing only the head run fails", (t) => {
  const slowBase = `await new Promise((resolve) => setTimeout(resolve, 600));\n${CHECK}`;
  const { root, tmp, run } = formalRepo(
    t,
    { ".agents/skills/formal-add/check.mjs": CHECK },
    { ".agents/skills/formal-add/check.mjs": slowBase },
  );
  const formal = verify(root, tmp, ["formal", run]);
  assert.equal(formal.status, 0, formal.stdout + formal.stderr);
  const result = evidence(run, "formal/formal-add/result.json");
  assert.equal(result.checkChanged, true);
  assert.ok(result.ms >= 550, `formal check took ${result.ms} ms`);
  assert.match(
    judged(root, tmp, run),
    /\| formal formal-add \| \d+\.\d s \|\n/,
  );
  delete result.ms;
  put(run, "evidence/formal/formal-add/result.json", JSON.stringify(result));
  assert.match(
    judged(root, tmp, run),
    /\| formal formal-add \| not measured \|\n/,
  );
});
