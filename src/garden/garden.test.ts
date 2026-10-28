import assert from "node:assert/strict";
import test from "node:test";

import { PartialFailure, type Check } from "./check.ts";
import { applyPauses, plannedPauses } from "./pauses.ts";
import { run } from "./helpers/builders.ts";
import { FakeApi, NOW } from "./helpers/fake-api.ts";
import { failureLines, garden } from "./run.ts";
import { finding, found, skip } from "./types.ts";

function check(id: string, ...subjects: string[]): Check {
  return {
    id,
    async run() {
      return found(
        subjects.map((subject) =>
          finding({ repo: "mongodb", check: id, subject }, "evidence", "done"),
        ),
      );
    },
  };
}

test("findings are sorted and de-duplicated by key, and the report is identical on a second run", async () => {
  const checks = [check("b", "z", "a"), check("a", "m"), check("b", "a")];
  const first = await garden(new FakeApi().org([]), {
    applyPauses: false,
    checks,
  });
  const second = await garden(new FakeApi().org([]), {
    applyPauses: false,
    checks,
  });
  assert.deepEqual(
    first.report.findings.map(({ key }) => key),
    ["mongodb|a|m", "mongodb|b|a", "mongodb|b|z"],
  );
  assert.deepEqual(second.report, first.report);
  assert.equal(first.report.generatedAt, NOW.toISOString());
});

test("a skipped source is listed without failing, a check that threw is listed and fails, and a partial failure keeps its findings", async () => {
  const checks: Check[] = [
    { id: "later", run: async () => skip("source not there yet") },
    {
      id: "broken",
      run: async () => {
        throw new Error("HTTP 403");
      },
    },
    {
      id: "partial",
      run: async () => {
        throw new PartialFailure(
          [finding({ repo: "r", check: "partial", subject: "s" }, "e", "d")],
          ["r: HTTP 500"],
        );
      },
    },
  ];
  const outcome = await garden(new FakeApi().org([]), {
    applyPauses: false,
    checks,
  });
  assert.deepEqual(
    outcome.report.skipped.map(({ check: id }) => id),
    ["broken", "later", "partial"],
  );
  assert.deepEqual(
    outcome.failures.map(({ check: id }) => id),
    ["broken", "partial"],
  );
  assert.deepEqual(
    outcome.report.findings.map(({ key }) => key),
    ["r|partial|s"],
  );
});

test("the plain output lists failures only, urgent ones marked, and nothing for a clean organization", async () => {
  const clean = await garden(new FakeApi().org([]), {
    applyPauses: false,
    checks: [],
  });
  assert.deepEqual(failureLines(clean), []);
  const urgent: Check = {
    id: "advisories",
    run: async () =>
      found([
        finding(
          { repo: "mongodb", check: "advisories", subject: "GHSA-1" },
          "critical in undici",
          "fixed",
          "urgent",
        ),
      ]),
  };
  const outcome = await garden(new FakeApi().org([]), {
    applyPauses: false,
    checks: [urgent],
  });
  assert.deepEqual(failureLines(outcome), [
    "URGENT mongodb advisories GHSA-1: critical in undici",
  ]);
});

function governed(variable: string, branch = "main"): FakeApi {
  return new FakeApi()
    .org([{ name: "mongodb", branch: branch === "next" ? "next" : undefined }])
    .ci("mongodb", [run(1, "success", 2)])
    .route("/repos/AntelopeJS/mongodb/actions/variables/NEXT_AUTOMERGE", {
      value: variable,
    });
}

const DRIFT = [
  finding(
    { repo: "mongodb", check: "next-governance", subject: "next:bypass" },
    "e",
    "d",
    "urgent",
  ),
];
const RATCHET = [
  finding(
    { repo: "mongodb", check: "conformance", subject: "ratchet" },
    "e",
    "d",
  ),
];

test("governance drift and a returning ratchet file pause only a repository where auto-merge is on", async () => {
  const on = await plannedPauses(governed("on").context(), [
    ...DRIFT,
    ...RATCHET,
  ]);
  assert.deepEqual(on, [
    {
      repo: "mongodb",
      from: "on",
      to: "shadow",
      reason:
        "the ratchet file is back on a Clean repository; governance drift",
    },
  ]);
  for (const value of ["off", "shadow"])
    assert.deepEqual(await plannedPauses(governed(value).context(), DRIFT), []);
  assert.deepEqual(await plannedPauses(governed("on").context(), []), []);
});

test("checks red on next after a merge pauses a repository, a red main does not", async () => {
  const redNext = governed("on", "next").ci("mongodb", [
    run(2, "failure", 1),
    run(1, "success", 5),
  ]);
  assert.deepEqual(
    (await plannedPauses(redNext.context(), [])).map(({ reason }) => reason),
    ["checks is red on next after a merge"],
  );
  const redMain = governed("on").ci("mongodb", [run(2, "failure", 1)]);
  assert.deepEqual(await plannedPauses(redMain.context(), []), []);
});

test("--apply-pauses writes the NEXT_AUTOMERGE variable of the paused repository and nothing else, never the value on", async () => {
  const api = governed("on");
  const planned = await plannedPauses(api.context(), DRIFT);
  const dry = await garden(api, {
    applyPauses: false,
    checks: [{ id: "next-governance", run: async () => found(DRIFT) }],
  });
  assert.deepEqual(api.writes, []);
  assert.equal(dry.report.pauses.length, 1);
  await applyPauses(api, planned);
  assert.deepEqual(api.writes, [
    {
      method: "PATCH",
      path: "/repos/AntelopeJS/mongodb/actions/variables/NEXT_AUTOMERGE",
      body: { name: "NEXT_AUTOMERGE", value: "shadow" },
    },
  ]);
});

test("a full run with the pause flag performs exactly the planned write and no other mutation", async () => {
  const api = governed("on");
  await garden(api, {
    applyPauses: true,
    checks: [{ id: "next-governance", run: async () => found(DRIFT) }],
  });
  assert.equal(api.writes.length, 1);
  assert.equal(api.writes[0].method, "PATCH");
  assert.deepEqual(api.writes[0].body, {
    name: "NEXT_AUTOMERGE",
    value: "shadow",
  });
});
