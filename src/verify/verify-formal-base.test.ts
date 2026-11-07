import assert from "node:assert/strict";
import test from "node:test";

import { put, read } from "../guardrails/helpers/test-repo.ts";
import {
  ADD,
  CHECK,
  CONFIG,
  SKILL,
  formalRepo,
  judged,
} from "./helpers/formal-repo.ts";
import { verify } from "./helpers/verify-repo.ts";

test("a diff that touches only a check's own files and makes it break a new rule fails; a gate that calls every finding of an unchanged behaviour known passes it", (t) => {
  const { root, tmp, run } = formalRepo(t, {
    ".agents/skills/formal-add/check.mjs": `${CHECK}console.log("finding Extra");\n`,
  });
  const formal = verify(root, tmp, ["formal", run]);
  assert.equal(formal.status, 1, formal.stdout);
  assert.equal(
    formal.stdout,
    "FAIL formal-add: covered behaviour unchanged (emit), but the check breaks rules the base did not: Extra\n",
  );
});

test("a diff that touches only a check's own files and keeps the base's findings passes them as known; a gate that fails every check edit with a finding fails it", (t) => {
  const { root, tmp, run } = formalRepo(t, {
    ".agents/skills/formal-add/check.mjs": `${CHECK}console.log("holds Other");\n`,
  });
  const formal = verify(root, tmp, ["formal", run]);
  assert.equal(formal.status, 0, formal.stdout);
  assert.equal(
    formal.stdout,
    "PASS formal-add: covered behaviour unchanged (emit): known findings NegativeZero\n",
  );
});

test("a check whose base run crashed cannot vouch for HEAD's findings and says the base is why; a gate that compares against the crashed base's empty rule list blames the check", (t) => {
  const { root, tmp, run } = formalRepo(
    t,
    { ".agents/skills/formal-add/check.mjs": CHECK },
    { ".agents/skills/formal-add/check.mjs": "process.exit(2);\n" },
  );
  const formal = verify(root, tmp, ["formal", run]);
  assert.equal(formal.status, 1, formal.stdout);
  assert.equal(
    formal.stdout,
    "FAIL formal-add: the base run exited 2, so NegativeZero cannot be compared with the base\n",
  );
});

const EXTRA = `${CHECK}console.log("finding Extra");\n`;

test("a check the diff adds under a new name passes its recorded findings, since the base cannot run a check it does not have; a gate that compares against the failed base run fails every new check", (t) => {
  const { root, tmp, run } = formalRepo(t, {
    [`${SKILL}/verify.config.ts`]: CONFIG.replaceAll(
      "formal-add",
      "formal-two",
    ),
    ".agents/skills/formal-two/check.mjs": CHECK,
  });
  const formal = verify(root, tmp, ["formal", run]);
  assert.equal(formal.status, 0, formal.stdout);
  assert.equal(
    formal.stdout,
    "PASS formal-two: new check, absent from the base: recorded findings NegativeZero\n",
  );
});

test("a check moved to a new folder under its old name is a changed check, so a finding it gains fails; a gate that calls a check new when its files are absent from the base passes it", (t) => {
  const { root, tmp, run } = formalRepo(t, {
    [`${SKILL}/verify.config.ts`]: CONFIG.replaceAll(
      "skills/formal-add/",
      "skills/formal-moved/",
    ),
    ".agents/skills/formal-moved/check.mjs": EXTRA,
  });
  const formal = verify(root, tmp, ["formal", run]);
  assert.equal(formal.status, 1, formal.stdout);
});

test("a check renamed and moved with git rename pairing its file is a changed check, so a finding it gains fails; a gate that looks only for the name on the base passes it", (t) => {
  const { root, tmp, run } = formalRepo(
    t,
    {
      [`${SKILL}/verify.config.ts`]: CONFIG.replaceAll(
        "formal-add",
        "formal-renamed",
      ),
      ".agents/skills/formal-renamed/check.mjs": EXTRA,
    },
    {},
    [".agents/skills/formal-add/check.mjs"],
  );
  const formal = verify(root, tmp, ["formal", run]);
  assert.equal(formal.status, 1, formal.stdout);
});

test("a check whose files are narrowed to a file the diff adds still runs on the base, so a finding it gains fails; a gate that calls a check new when its new files are absent from the base passes it", (t) => {
  const { root, tmp, run } = formalRepo(t, {
    [`${SKILL}/verify.config.ts`]: CONFIG.replace(
      '[".agents/skills/formal-add/**"]',
      '[".agents/skills/formal-add/record.json"]',
    ),
    ".agents/skills/formal-add/record.json": "{}\n",
    ".agents/skills/formal-add/check.mjs": EXTRA,
  });
  const formal = verify(root, tmp, ["formal", run]);
  assert.equal(formal.status, 1, formal.stdout);
  assert.match(formal.stdout, /breaks rules the base did not: Extra/);
});

test("a new check on a diff that also changes the covered behaviour fails, as any finding on a changed behaviour does; a gate that passes every new check passes it", (t) => {
  const { root, tmp, run } = formalRepo(t, {
    [`${SKILL}/verify.config.ts`]: CONFIG.replaceAll(
      "formal-add",
      "formal-two",
    ),
    ".agents/skills/formal-two/check.mjs": CHECK,
    "src/math.js": ADD.replace("a + b", "b + a"),
  });
  const formal = verify(root, tmp, ["formal", run]);
  assert.equal(formal.status, 1, formal.stdout);
  assert.equal(
    formal.stdout,
    "FAIL formal-two: new check with a covered-code change: land the check in its own PR first\n",
  );
});

test("a result whose check files changed but that recorded no base run fails the verdict; a gate that trusts a missing base calls the findings known", (t) => {
  const { root, tmp, run } = formalRepo(t, {
    ".agents/skills/formal-add/check.mjs": `${CHECK}console.log("holds Other");\n`,
  });
  assert.equal(verify(root, tmp, ["formal", run]).status, 0);
  const file = "evidence/formal/formal-add/result.json";
  const { base: _base, ...rest } = JSON.parse(read(run, file));
  put(run, file, JSON.stringify(rest));
  assert.match(
    judged(root, tmp, run),
    /- formal check formal-add: the check's own files changed but no base run was recorded\n/,
  );
});
