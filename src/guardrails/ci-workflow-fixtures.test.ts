import assert from "node:assert/strict";
import test from "node:test";
import { parseDocument } from "yaml";

import { ciFindings } from "./helpers/ci-audit.ts";
import { callerInputs, fixture, jobsOf, syncCi } from "./helpers/ci-text.ts";

const GATE_IF =
  "${{ !cancelled() && !contains(needs.*.result, 'failure') && !contains(needs.*.result, 'cancelled') }}";

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

function advisoryKinds(advisories: string[]): string[] {
  return advisories.map((note) => note.split(":")[0]);
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

test("dms-lang: select, e2e and e2e-report get Blacksmith runners and pinned actions and ci needs them under the gate if, while ubuntu and verdict stay unwired with no gate advisory and the concurrency is untouched", () => {
  const before = fixture("dms-lang-ci.yml");
  const once = syncCi(before);
  const jobs = jobsOf(once.content);
  for (const id of ["select", "e2e", "e2e-report"])
    assert.equal(jobs[id]["runs-on"], "blacksmith-4vcpu-ubuntu-2404", id);
  assert.deepEqual(jobs.ci.needs, ["select", "e2e", "e2e-report"]);
  assert.equal(jobs.ci.if, GATE_IF);
  assert.deepEqual(jobs.ubuntu.needs, ["select", "ci", "e2e"]);
  assert.equal(jobs.ubuntu.if, "always()");
  assert.deepEqual(advisoryKinds(once.advisories), []);
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

test("dms-antelope-cloud: tier, backend, e2e, e2e-report and leaks are wired into ci, every runner is a literal, the pins are applied and module-locks is untouched", () => {
  const before = fixture("dms-antelope-cloud-ci.yml");
  const once = syncCi(before);
  const jobs = jobsOf(once.content);
  assert.deepEqual(jobs.ci.needs, [
    "tier",
    "backend",
    "e2e",
    "e2e-report",
    "leaks",
  ]);
  assert.equal(jobs.ci.if, GATE_IF);
  for (const id of ["tier", "backend", "e2e", "e2e-report", "leaks", "ubuntu"])
    assert.equal(jobs[id]["runs-on"], "blacksmith-4vcpu-ubuntu-2404", id);
  assert.deepEqual(jobs["module-locks"], jobsOf(before)["module-locks"]);
  assert.deepEqual(jobs.ubuntu.needs, jobsOf(before).ubuntu.needs);
  assert.ok(
    once.content.includes(
      "uses: AntelopeJS/.github/.github/actions/ci-tier@v2\n",
    ),
  );
  assert.deepEqual(advisoryKinds(once.advisories), []);
  assert.deepEqual(ciFindings(once.content), []);
  assert.equal(syncCi(once.content).content, once.content);
  assert.equal(
    parseDocument(once.content).toJS().concurrency["cancel-in-progress"],
    "${{ github.event_name == 'pull_request' }}",
  );
});

test("dms-antelope-cloud: a job that needs ci and is not an aggregator is reported and left out of ci's needs, so a sync that wires it into a cycle or stays silent fails", () => {
  const before = `${fixture("dms-antelope-cloud-ci.yml")}  deploy:\n    needs: [ci]\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n`;
  const once = syncCi(before);
  assert.deepEqual(jobsOf(once.content).ci.needs, [
    "tier",
    "backend",
    "e2e",
    "e2e-report",
    "leaks",
  ]);
  assert.deepEqual(once.advisories, [
    "Gate: .github/workflows/ci.yml job deploy runs beside the ci caller, so ci / checks passes when it fails. It needs ci, so ci cannot need it. Move it into an input of ci-node.yml, or have the ci job need it.",
  ]);
  assert.equal(syncCi(once.content).content, once.content);
});

test("antelope-web: the site build matrix joins ci's needs, so ci / checks waits for Build (dms); its runner and pins move and cancel-in-progress true becomes the pull-request-only expression, so a sync that leaves build beside ci or cancels a merge queue run fails", () => {
  const before = fixture("antelope-web-ci.yml");
  const once = syncCi(before);
  const jobs = jobsOf(once.content);
  assert.deepEqual(jobs.ci.needs, ["build"]);
  assert.equal(jobs.ci.if, GATE_IF);
  assert.equal(jobs.build["runs-on"], "blacksmith-4vcpu-ubuntu-2404");
  const concurrency = parseDocument(once.content).toJS().concurrency;
  assert.deepEqual(concurrency, {
    group: "ci-${{ github.ref }}",
    "cancel-in-progress": "${{ github.event_name == 'pull_request' }}",
  });
  assert.doesNotMatch(once.content, /# v4/);
  assert.deepEqual(advisoryKinds(once.advisories), []);
  assert.deepEqual(ciFindings(once.content), []);
  assert.equal(syncCi(once.content).content, once.content);
});
