import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import {
  ADD,
  CONFIG,
  LENGTH_CHECK,
  SKILL,
  formalRepo,
  judged,
} from "./helpers/formal-repo.ts";
import { verify } from "./helpers/verify-repo.ts";

function lengthRepo(t: TestContext, math: string) {
  return formalRepo(
    t,
    { "src/math.js": math },
    { ".agents/skills/formal-add/check.mjs": LENGTH_CHECK },
  );
}

test("a changed behaviour that breaks the same findings as the base with the same counterexample lengths passes as known", (t) => {
  const { root, tmp, run } = lengthRepo(t, ADD.replace("a + b", "b + a"));
  const formal = verify(root, tmp, ["formal", run]);
  assert.equal(formal.status, 0, formal.stdout + formal.stderr);
  assert.equal(
    formal.stdout,
    "PASS formal-add: covered behaviour changed (emit), same known findings as base: NegativeZero\n",
  );
  assert.doesNotMatch(judged(root, tmp, run), /- formal check formal-add/);
});

test("a changed behaviour that breaks one more rule than the base fails, though the base's findings keep their lengths", (t) => {
  const { root, tmp, run } = lengthRepo(
    t,
    `${ADD}export const extra = true;\n`,
  );
  const formal = verify(root, tmp, ["formal", run]);
  assert.equal(formal.status, 1);
  assert.equal(
    formal.stdout,
    "FAIL formal-add: covered behaviour changed (emit), violated NegativeZero, Extra\n",
  );
});

test("a changed behaviour whose finding has another counterexample length than on the base fails", (t) => {
  const { root, tmp, run } = lengthRepo(t, `${ADD}export const steps = [4];\n`);
  const formal = verify(root, tmp, ["formal", run]);
  assert.equal(formal.status, 1);
  assert.equal(
    formal.stdout,
    "FAIL formal-add: covered behaviour changed (emit), violated NegativeZero\n",
  );
});

test("a changed behaviour whose finding prints two different counterexample lengths fails", (t) => {
  const { root, tmp, run } = lengthRepo(
    t,
    `${ADD}export const steps = [3, 4];\n`,
  );
  const formal = verify(root, tmp, ["formal", run]);
  assert.equal(formal.status, 1);
  assert.equal(
    formal.stdout,
    "FAIL formal-add: covered behaviour changed (emit), violated NegativeZero\n",
  );
});

test("a changed behaviour that drops a finding the base broke fails through missing, not as a known finding", (t) => {
  const { root, tmp, run } = lengthRepo(t, `${ADD}export const steps = [];\n`);
  const formal = verify(root, tmp, ["formal", run]);
  assert.equal(formal.status, 1);
  assert.equal(
    formal.stdout,
    "FAIL formal-add: rules the base broke are absent at HEAD: NegativeZero\n",
  );
});

/** A check that prints the line the covered code exports as `line`, or `baseLine` on the base, which exports none. */
function lineCheck(baseLine: string) {
  return `import { join } from "node:path";
import { pathToFileURL } from "node:url";
const math = await import(pathToFileURL(join(process.cwd(), "src/math.js")).href);
console.log(math.line ?? ${JSON.stringify(baseLine)});
`;
}

function replaced(text: string, from: string, to: string) {
  assert.ok(text.includes(from), from);
  return text.replace(from, to);
}

function lineRepo(
  t: TestContext,
  violation: string,
  line: string,
  baseLine: string,
) {
  return formalRepo(
    t,
    { "src/math.js": `${ADD}export const line = ${JSON.stringify(line)};\n` },
    {
      ".agents/skills/formal-add/check.mjs": lineCheck(baseLine),
      [`${SKILL}/verify.config.ts`]: replaced(
        CONFIG,
        "/^(?:finding|BROKEN) (\\w+)(?:: (?<states>\\d+) states)?/gm",
        violation,
      ),
    },
  );
}

test("a violation regex whose first group is states gives no length, so another rule with the same length fails; a gate that names rules by group 1 reads both as rule 3 and passes", (t) => {
  const { root, tmp, run } = lineRepo(
    t,
    "/^finding \\w+: (?<states>\\d+) states/gm",
    "finding Other: 3 states",
    "finding NegativeZero: 3 states",
  );
  const formal = verify(root, tmp, ["formal", run]);
  assert.equal(formal.status, 1, formal.stdout);
  assert.match(formal.stdout, /^FAIL formal-add: covered behaviour changed/);
});

test("a states group that captures no digits gives no length; Number() would read an empty capture as 0 and pass it against a base that printed 0", (t) => {
  const { root, tmp, run } = lineRepo(
    t,
    "/^finding (\\w+):(?: (?<states>\\d*))?/gm",
    "finding NegativeZero: ",
    "finding NegativeZero: 0",
  );
  const formal = verify(root, tmp, ["formal", run]);
  assert.equal(formal.status, 1, formal.stdout);
  assert.equal(
    formal.stdout,
    "FAIL formal-add: covered behaviour changed (emit), violated NegativeZero\n",
  );
});

test("a numeric rule whose length equals its name keeps that length in its own states group; a parser that compares the captured text drops it and fails a same-findings run", (t) => {
  const { root, tmp, run } = lineRepo(
    t,
    "/^finding (\\w+): (?<states>\\d+) states/gm",
    "finding 3: 3 states",
    "finding 3: 3 states",
  );
  const formal = verify(root, tmp, ["formal", run]);
  assert.equal(formal.status, 0, formal.stdout);
  assert.equal(
    formal.stdout,
    "PASS formal-add: covered behaviour changed (emit), same known findings as base: 3\n",
  );
});
