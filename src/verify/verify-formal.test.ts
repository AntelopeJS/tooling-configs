import assert from "node:assert/strict";
import test from "node:test";

import { put } from "../guardrails/helpers/test-repo.ts";
import { ADD, CHECK, formalRepo, judged } from "./helpers/formal-repo.ts";
import { evidence, verify } from "./helpers/verify-repo.ts";

const CHECK_FILE = ".agents/skills/formal-add/check.mjs";
const BROKEN_ADD = ADD.replace("a + b", "a - b");

test("a covered check that holds prints HOLDS and leaves the verdict alone; a runner that fails every covered check fails it", (t) => {
  const { root, tmp, run } = formalRepo(t, {
    "src/math.js": `${ADD}// a comment\n`,
  });
  const formal = verify(root, tmp, ["formal", run]);
  assert.equal(formal.status, 0, formal.stdout + formal.stderr);
  assert.equal(formal.stdout, "HOLDS formal-add: no violated rule (exit 0)\n");
  const verdict = judged(root, tmp, run);
  assert.match(
    verdict,
    /`formal-add` \(covers the diff, gates the verdict\): HOLDS no violated rule \(exit 0\)\./,
  );
  assert.doesNotMatch(verdict, /- formal check formal-add/);
});

test("a covered change that breaks a rule prints VIOLATED and fails the verdict; a runner that passes a finding the base also had passes it", (t) => {
  const { root, tmp, run } = formalRepo(
    t,
    { "src/math.js": `${BROKEN_ADD}// still broken\n` },
    { "src/math.js": BROKEN_ADD },
  );
  const formal = verify(root, tmp, ["formal", run]);
  assert.equal(formal.status, 1, formal.stdout + formal.stderr);
  assert.equal(
    formal.stdout,
    "VIOLATED formal-add: violated AddWorks (exit 1)\n",
  );
  assert.match(
    judged(root, tmp, run),
    /- formal check formal-add: VIOLATED violated AddWorks \(exit 1\)\n/,
  );
});

test("a check that exits 0 while it reports a broken rule is VIOLATED; a runner that reads only the exit code passes it", (t) => {
  const { root, tmp, run } = formalRepo(t, {
    [CHECK_FILE]: 'console.log("BROKEN Recorded");\n',
  });
  const formal = verify(root, tmp, ["formal", run]);
  assert.equal(formal.status, 1, formal.stdout + formal.stderr);
  assert.equal(
    formal.stdout,
    "VIOLATED formal-add: violated Recorded (exit 0)\n",
  );
});

test("a check that exits non-zero without naming a rule is an ERROR; a runner that needs a named rule to fail passes it", (t) => {
  const { root, tmp, run } = formalRepo(t, {
    [CHECK_FILE]: "process.exitCode = 2;\n",
  });
  const formal = verify(root, tmp, ["formal", run]);
  assert.equal(formal.status, 1, formal.stdout + formal.stderr);
  assert.equal(formal.stdout, "ERROR formal-add: tool error (exit 2)\n");
  assert.match(
    judged(root, tmp, run),
    /- formal check formal-add: ERROR tool error \(exit 2\)\n/,
  );
});

test("a check the diff does not cover runs only under --all and fails nothing; a runner that gates every check it runs fails it", (t) => {
  const { root, tmp, run } = formalRepo(
    t,
    { "README.md": "# Demo, edited\n" },
    { "src/math.js": BROKEN_ADD },
  );
  const touched = verify(root, tmp, ["formal", run]);
  assert.equal(touched.status, 0, touched.stdout + touched.stderr);
  assert.equal(touched.stdout, "no formal check covers the diff\n");
  const all = verify(root, tmp, ["formal", run, "--all"]);
  assert.equal(all.status, 0, all.stdout + all.stderr);
  assert.equal(all.stdout, "VIOLATED formal-add: violated AddWorks (exit 1)\n");
  assert.match(
    judged(root, tmp, run),
    /`formal-add` \(does not cover the diff, informational\): VIOLATED violated AddWorks \(exit 1\)\./,
  );
});

test("a diff that touches only a check's own files runs the check; a runner that looks only at covered sources skips it", (t) => {
  const { root, tmp, run } = formalRepo(t, {
    [CHECK_FILE]: `${CHECK}console.log("BROKEN Edited");\n`,
  });
  const formal = verify(root, tmp, ["formal", run]);
  assert.equal(formal.status, 1, formal.stdout + formal.stderr);
  assert.equal(
    formal.stdout,
    "VIOLATED formal-add: violated Edited (exit 0)\n",
  );
});

test("a formal check's time shows in the verdict, and `not measured` when the result predates timings; a result without its time fails", (t) => {
  const { root, tmp, run } = formalRepo(t, {
    [CHECK_FILE]: `await new Promise((resolve) => setTimeout(resolve, 600));\n${CHECK}`,
  });
  const formal = verify(root, tmp, ["formal", run]);
  assert.equal(formal.status, 0, formal.stdout + formal.stderr);
  const result = evidence(run, "formal/formal-add/result.json");
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
