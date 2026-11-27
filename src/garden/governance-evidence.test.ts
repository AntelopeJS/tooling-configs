import assert from "node:assert/strict";
import test from "node:test";

import { branchGovernance } from "./checks/governance.ts";
import { FakeApi } from "./helpers/fake-api.ts";

const UNMET = [
  [
    "rule:deletion",
    "The rules in force on main hold no deletion rule.",
    "The rules in force on main hold a deletion rule.",
  ],
  [
    "rule:non_fast_forward",
    "The rules in force on main hold no non_fast_forward rule.",
    "The rules in force on main hold a non_fast_forward rule.",
  ],
  [
    "rule:required_linear_history",
    "The rules in force on main hold no required_linear_history rule.",
    "The rules in force on main hold a required_linear_history rule.",
  ],
  [
    "rule:pull_request",
    "The rules in force on main hold no pull_request rule.",
    "The rules in force on main hold a pull_request rule.",
  ],
  [
    "checks",
    "The rules in force on main hold no verdict or ci / checks from GitHub Actions as a required status check.",
    "The rules in force on main hold verdict or ci / checks from GitHub Actions as a required status check.",
  ],
  [
    "rule:merge_queue",
    "The rules in force on main hold no merge_queue rule.",
    "The rules in force on main hold a merge_queue rule.",
  ],
];

test("an unmet rule reads 'hold no <rule>' with no doubled article, and its done means names it with one", async () => {
  const api = new FakeApi()
    .org([{ name: "mongodb" }])
    .route("/repos/AntelopeJS/mongodb/rules/branches/main", []);
  const result = await branchGovernance.run(api.context());
  assert.equal(result.kind, "findings");
  if (result.kind !== "findings") return;
  assert.deepEqual(
    result.findings.map(({ subject, evidence, doneMeans }) => [
      subject.replace("main:", ""),
      evidence,
      doneMeans,
    ]),
    UNMET,
  );
});
