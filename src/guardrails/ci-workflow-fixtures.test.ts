import assert from "node:assert/strict";
import test from "node:test";
import { parseDocument } from "yaml";

import { GATE_CONDITION } from "./ci-gate.ts";
import { ciProfile } from "./ci-profile.ts";
import { ciFindings } from "./helpers/ci-audit.ts";
import { callerInputs, fixture, jobsOf, syncCi } from "./helpers/ci-text.ts";

const CLOUD = { profile: ciProfile("@antelopejs/dms-antelope-cloud") };
const WEB = { profile: ciProfile("antelope-web") };

const BILLING = {
  skills: [
    {
      name: "formal-billing-lease",
      markdown: fixture("payment-subscriptions-formal-billing-lease.SKILL.md"),
    },
  ],
  files: [
    "src/clock.ts",
    "src/engine.ts",
    "src/records.ts",
    "src/transitions.ts",
    "src/triggers.ts",
  ],
};

const MYSQL_SKILLS = [
  "formal-change-feed-delivery",
  "formal-json-value-identity",
  "formal-mariadb-read-warnings",
  "formal-merge-repeated-keys",
  "formal-pipeline-chains",
  "formal-unique-index-gate",
];

function checksOf(text: string): { skill: string; paths?: string[] }[] {
  return JSON.parse(String(callerInputs(text)["formal-checks"]));
}

test("payment-subscriptions: the formal job and the checks aggregator are replaced by a formal-checks entry, no finding is left and a rerun changes nothing", () => {
  const before = fixture("payment-subscriptions-ci.yml");
  const once = syncCi(before, { formal: BILLING });
  assert.deepEqual(Object.keys(jobsOf(once.content)), [
    "ci",
    "renovate-sync",
    "verdict",
  ]);
  assert.deepEqual(checksOf(once.content), [
    {
      skill: "formal-billing-lease",
      paths: [
        "src/clock.ts",
        "src/engine.ts",
        "src/records.ts",
        "src/transitions.ts",
        "src/triggers.ts",
      ],
    },
  ]);
  assert.deepEqual(ciFindings(once.content), []);
  assert.deepEqual(once.advisories, []);
  assert.equal(syncCi(once.content, { formal: BILLING }).content, once.content);
});

test("payment-subscriptions: the input is the block literal the shared workflow reads, so a serializer that quotes or reflows it fails", () => {
  const { content } = syncCi(fixture("payment-subscriptions-ci.yml"), {
    formal: BILLING,
  });
  assert.ok(
    content.includes(
      '      formal-checks: |\n        [\n          {"skill": "formal-billing-lease", "paths": ["src/clock.ts", "src/engine.ts", "src/records.ts", "src/transitions.ts", "src/triggers.ts"]}\n        ]\n',
    ),
    content,
  );
});

test("mysql: the three check lines leave extra-commands and pnpm run test:bench stays, all six skills land in formal-checks and a rerun changes nothing", () => {
  const formal = {
    skills: MYSQL_SKILLS.map((name) => ({ name, markdown: "" })),
    files: [],
  };
  const once = syncCi(fixture("mysql-ci.yml"), { formal });
  assert.equal(
    callerInputs(once.content)["extra-commands"],
    "pnpm run test:bench\n",
  );
  assert.deepEqual(
    checksOf(once.content).map(({ skill }) => skill),
    MYSQL_SKILLS,
  );
  assert.equal(syncCi(once.content, { formal }).content, once.content);
  assert.deepEqual(ciFindings(once.content), []);
});

test("dms-lang: select, e2e and e2e-report get Blacksmith runners and pinned actions, ci needs none of them and one gate advisory names verdict, the one aggregator that needs all three with ci, while the concurrency is untouched", () => {
  const before = fixture("dms-lang-ci.yml");
  const once = syncCi(before, { profile: ciProfile("@antelopejs/dms-lang") });
  const jobs = jobsOf(once.content);
  for (const id of ["select", "e2e", "e2e-report"])
    assert.equal(jobs[id]["runs-on"], "blacksmith-4vcpu-ubuntu-2404", id);
  assert.equal(jobs.ci.needs, undefined);
  assert.equal(jobs.ci.if, undefined);
  assert.deepEqual(jobs.ubuntu.needs, ["select", "ci", "e2e"]);
  assert.equal(jobs.ubuntu.if, "always()");
  assert.deepEqual(once.advisories, [
    "Gate: .github/workflows/ci.yml jobs select, e2e, e2e-report run beside the ci caller, so ci / checks passes when one fails. verdict needs them with ci, so require verdict in the ruleset.",
  ]);
  assert.ok(
    once.content.includes(
      "concurrency:\n  group: ${{ github.workflow }}-${{ github.ref }}\n  cancel-in-progress: ${{ github.event_name == 'pull_request' }}\n",
    ),
  );
  assert.match(
    once.content,
    /- uses: actions\/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7\.0\.1\n/,
  );
  assert.doesNotMatch(once.content, /# v4/);
  assert.match(
    once.content,
    /^# Parallel jobs on Linux and Windows|# Parallel jobs on Linux and Windows/m,
  );
  assert.deepEqual(ciFindings(once.content), []);
  assert.equal(syncCi(once.content).content, once.content);
});

const CALLER_USES =
  "    uses: AntelopeJS/.github/.github/workflows/ci-node.yml@v2\n";

/** `name` as the earlier sync with gateHandJobs wrote it: ci needs `needs` under the gate if. */
function gatedFixture(name: string, needs: readonly string[]): string {
  const text = fixture(name);
  assert.equal(text.split(CALLER_USES).length, 2, name);
  return text.replace(
    CALLER_USES,
    `    needs: [${needs.join(", ")}]\n    if: ${GATE_CONDITION}\n${CALLER_USES}`,
  );
}

test("dms-antelope-cloud: the ci an earlier sync wired to tier, backend, e2e, e2e-report and leaks needs none of them again and one advisory names ubuntu, every runner is a literal, the pins are applied and module-locks is untouched, so a sync that keeps ci waiting behind the e2e jobs, or skipped with ci / checks unreported when one fails, fails", () => {
  const before = gatedFixture("dms-antelope-cloud-ci.yml", [
    "tier",
    "backend",
    "e2e",
    "e2e-report",
    "leaks",
  ]);
  const once = syncCi(before, CLOUD);
  const jobs = jobsOf(once.content);
  assert.equal(jobs.ci.needs, undefined);
  assert.equal(jobs.ci.if, undefined);
  for (const id of ["tier", "backend", "e2e", "e2e-report", "leaks", "ubuntu"])
    assert.equal(jobs[id]["runs-on"], "blacksmith-4vcpu-ubuntu-2404", id);
  assert.deepEqual(jobs["module-locks"], jobsOf(before)["module-locks"]);
  assert.deepEqual(jobs.ubuntu.needs, jobsOf(before).ubuntu.needs);
  assert.ok(
    once.content.includes(
      "uses: AntelopeJS/.github/.github/actions/ci-tier@v2\n",
    ),
  );
  assert.deepEqual(once.advisories, [
    "Gate: .github/workflows/ci.yml jobs tier, backend, e2e, e2e-report, leaks run beside the ci caller, so ci / checks passes when one fails. ubuntu needs them with ci, so require ubuntu in the ruleset.",
  ]);
  assert.deepEqual(ciFindings(once.content), []);
  assert.equal(syncCi(once.content, CLOUD).content, once.content);
  assert.equal(
    parseDocument(once.content).toJS().concurrency["cancel-in-progress"],
    "${{ github.event_name == 'pull_request' }}",
  );
});

test("antelope-web: the ci an earlier sync wired to the site build matrix needs it no longer, so ci / checks reports without waiting for Build (dms); its runner and pins move and cancel-in-progress true becomes the pull-request-only expression, so a sync that keeps build in ci's needs or cancels a merge queue run fails", () => {
  const before = gatedFixture("antelope-web-ci.yml", ["build"]);
  const once = syncCi(before, WEB);
  const jobs = jobsOf(once.content);
  assert.equal(jobs.ci.needs, undefined);
  assert.equal(jobs.ci.if, undefined);
  assert.equal(jobs.build["runs-on"], "blacksmith-4vcpu-ubuntu-2404");
  const concurrency = parseDocument(once.content).toJS().concurrency;
  assert.deepEqual(concurrency, {
    group: "ci-${{ github.ref }}",
    "cancel-in-progress": "${{ github.event_name == 'pull_request' }}",
  });
  assert.doesNotMatch(once.content, /# v4/);
  assert.deepEqual(once.advisories, [
    "Gate: .github/workflows/ci.yml job build runs beside the ci caller, so ci / checks passes when it fails. verdict needs it with ci, so require verdict in the ruleset.",
  ]);
  assert.deepEqual(ciFindings(once.content), []);
  assert.equal(syncCi(once.content, WEB).content, once.content);
});

const DMS_SKILLS = [
  "formal-a",
  "formal-b",
  "formal-c",
  "formal-d",
  "formal-e",
  "formal-f",
  "formal-g",
  "formal-h",
  "formal-i",
  "formal-j",
  "formal-k",
];

test("dms: the formal and formal-generated jobs calling local workflows keep every skill out of formal-checks, and an input an earlier sync wrote is removed", () => {
  const formal = {
    skills: DMS_SKILLS.map((name) => ({ name, markdown: "" })),
    files: [],
  };
  const before = fixture("dms-ci.yml");
  const once = syncCi(before, { formal });
  assert.equal(callerInputs(once.content)["formal-checks"], undefined);
  assert.ok(jobsOf(once.content).formal.uses);
  assert.ok(jobsOf(once.content)["formal-generated"].uses);
  assert.equal(syncCi(once.content, { formal }).content, once.content);
  const written = before.replace(
    "      module-locks: true\n",
    `      module-locks: true\n      formal-checks: |\n        [\n          {"skill": "formal-a"}\n        ]\n`,
  );
  assert.notEqual(written, before);
  assert.equal(
    callerInputs(syncCi(written, { formal }).content)["formal-checks"],
    undefined,
  );
});
