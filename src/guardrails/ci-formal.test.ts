import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import test from "node:test";

import { formalPlan, type FormalPlan } from "./ci-formal.ts";
import {
  callerInputs,
  jobsOf,
  syncCi,
  workflowWith,
} from "./helpers/ci-text.ts";
import { commit, put, testRepo } from "./helpers/test-repo.ts";
import { RUNS_ON } from "./ci-hand-jobs.ts";

const COVERAGE = (...files: string[]) =>
  `## Coverage record\n\n| Model | Code |\n| --- | --- |\n${files.map((file) => `| \`A\` | ${file} |`).join("\n")}\n`;

function plan(
  skills: Record<string, string>,
  files = ["src/a.ts", "src/b.ts"],
): FormalPlan {
  return {
    skills: Object.entries(skills).map(([name, markdown]) => ({
      name,
      markdown,
    })),
    files,
  };
}

function movable(id: string, skill: string, args = ""): string {
  return `  ${id}:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version-file: .nvmrc
      - run: corepack enable
      - run: pnpm install --frozen-lockfile --ignore-scripts
      - uses: actions/setup-java@v4
        with:
          distribution: temurin
          java-version: "21"
      - uses: actions/cache@v4
        with:
          path: ~/.cache/antelopejs-formal
          key: antelopejs-formal
      - run: node .agents/skills/${skill}/check.mjs${args}
`;
}

const DEPLOY = `  deploy:
    needs: [ci, formal-a]
    runs-on: ${RUNS_ON.linux}
    steps:
      - uses: actions/checkout@v7
`;

function withInputs(jobs: string, inputs: string): string {
  return workflowWith(jobs).replace(
    "ci-node.yml@v2\n",
    `ci-node.yml@v2\n    with:\n${inputs}`,
  );
}

interface CheckEntry {
  skill: string;
  run?: string;
  paths?: string[];
}

function checksOf(text: string): CheckEntry[] | undefined {
  const value = callerInputs(text)["formal-checks"];
  return value === undefined ? undefined : JSON.parse(String(value));
}

test("a formal job that only sets up and runs a check moves into formal-checks and its needs entries go, so a sync that keeps the job or leaves a dangling need fails", () => {
  const text = workflowWith(`${movable("formal-a", "formal-a")}${DEPLOY}`);
  const { content } = syncCi(text, { formal: plan({ "formal-a": "" }) });
  assert.equal(jobsOf(content)["formal-a"], undefined);
  assert.deepEqual(jobsOf(content).deploy.needs, ["ci"]);
  assert.deepEqual(checksOf(content), [{ skill: "formal-a" }]);
  assert.equal(
    syncCi(content, { formal: plan({ "formal-a": "" }) }).content,
    content,
  );
});

test("a job whose only need was the moved formal job needs ci instead, so a sync that drops its needs and leaves it ungated fails", () => {
  const text = workflowWith(
    `${movable("formal-a", "formal-a")}  notify:\n    needs: formal-a\n    runs-on: ${RUNS_ON.linux}\n    steps:\n      - uses: actions/checkout@v7\n`,
  );
  const { content } = syncCi(text, { formal: plan({ "formal-a": "" }) });
  assert.equal(jobsOf(content)["formal-a"], undefined);
  assert.equal(jobsOf(content).notify.needs, "ci");
  assert.deepEqual(checksOf(content), [{ skill: "formal-a" }]);
});

test("formal-checks is a block literal with one object per line in the order skill, run, paths, so a serializer that writes compact JSON or another key order fails", () => {
  const text = withInputs(
    `${movable("formal-b", "formal-b", " --full")}${movable("formal-a", "formal-a")}`,
    "      renovate-sync: false\n",
  );
  const { content } = syncCi(text, {
    formal: plan(
      { "formal-b": COVERAGE("a.ts"), "formal-a": COVERAGE("b.ts", "a.ts") },
      ["src/a.ts", "src/b.ts"],
    ),
  });
  assert.ok(
    content.includes(
      `      formal-checks: |\n        [\n          {"skill": "formal-a", "paths": ["src/a.ts", "src/b.ts"]},\n          {"skill": "formal-b", "run": "node .agents/skills/formal-b/check.mjs --full", "paths": ["src/a.ts"]}\n        ]\n`,
    ),
    content,
  );
});

test("a formal job with anything beyond setup stays and its skill stays out of formal-checks, so a sync that moves it or runs the check twice fails", () => {
  const variants = new Map<string, (job: string) => string>(
    Object.entries({
      strategy: (job) =>
        job.replace(
          "    steps:",
          "    strategy:\n      matrix:\n        n: [1]\n    steps:",
        ),
      env: (job) =>
        job.replace("    steps:", "    env:\n      A: b\n    steps:"),
      services: (job) =>
        job.replace(
          "    steps:",
          "    services:\n      db:\n        image: x\n    steps:",
        ),
      container: (job) =>
        job.replace("    steps:", "    container: node:24\n    steps:"),
      outputs: (job) =>
        job.replace("    steps:", "    outputs:\n      a: b\n    steps:"),
      needs: (job) =>
        job.replace("    steps:", "    needs: [other]\n    steps:"),
      "job if": (job) =>
        job.replace("    steps:", "    if: always()\n    steps:"),
      "another command": (job) =>
        job.replace(
          "      - run: corepack enable\n",
          "      - run: pnpm run build\n",
        ),
      "another action": (job) =>
        job.replace(
          "      - uses: actions/cache@v4",
          "      - uses: some/action@v1",
        ),
      "step env": (job) =>
        job.replace(
          "      - run: corepack enable\n",
          "      - run: corepack enable\n        env:\n          A: b\n",
        ),
    }),
  );
  for (const [name, vary] of variants) {
    const text = workflowWith(
      `${vary(movable("formal-a", "formal-a"))}  other:\n    runs-on: ${RUNS_ON.linux}\n    steps:\n      - run: pnpm lint\n`,
    );
    const { content } = syncCi(text, {
      formal: plan({ "formal-a": "", "formal-b": "" }),
    });
    assert.notEqual(jobsOf(content)["formal-a"], undefined, name);
    assert.deepEqual(checksOf(content), [{ skill: "formal-b" }], name);
  }
});

test("a formal job that another job reads through needs.<id> stays, so a sync that moves it breaks the reader's condition", () => {
  const text = workflowWith(
    `${movable("formal-a", "formal-a")}  report:\n    needs: formal-a\n    if: needs.formal-a.result == 'success'\n    runs-on: ${RUNS_ON.linux}\n    steps:\n      - uses: actions/checkout@v7\n`,
  );
  const { content } = syncCi(text, { formal: plan({ "formal-a": "" }) });
  assert.notEqual(jobsOf(content)["formal-a"], undefined);
  assert.equal(checksOf(content), undefined);
});

test("a job running a check whose skill folder is missing stays, so a sync that deletes it drops the check", () => {
  const text = workflowWith(movable("formal-a", "formal-a"));
  const { content } = syncCi(text, { formal: plan({ "formal-b": "" }) });
  assert.notEqual(jobsOf(content)["formal-a"], undefined);
});

test("extra-commands lines that only run a check leave and the others stay, so a sync that drops the other commands or keeps a check line fails", () => {
  const text = withInputs(
    "",
    "      extra-commands: |\n        node .agents/skills/formal-a/check.mjs\n        pnpm run test:bench\n        node .agents/skills/formal-b/check.mjs --full\n",
  );
  const { content } = syncCi(text, {
    formal: plan({ "formal-a": "", "formal-b": "" }),
  });
  assert.equal(
    callerInputs(content)["extra-commands"],
    "pnpm run test:bench\n",
  );
  assert.deepEqual(checksOf(content), [
    { skill: "formal-a" },
    { skill: "formal-b", run: "node .agents/skills/formal-b/check.mjs --full" },
  ]);
});

test("extra-commands is deleted when only check lines were in it, so a sync that leaves an empty input fails", () => {
  const text = withInputs(
    "",
    "      extra-commands: |\n        node .agents/skills/formal-a/check.mjs\n      renovate-sync: false\n",
  );
  const { content } = syncCi(text, { formal: plan({ "formal-a": "" }) });
  assert.equal(Object.hasOwn(callerInputs(content), "extra-commands"), false);
  assert.equal(callerInputs(content)["renovate-sync"], false);
});

test("an extra-commands line of a skill without a folder stays, so a sync that removes it drops the check", () => {
  const text = withInputs(
    "",
    "      extra-commands: |\n        node .agents/skills/formal-z/check.mjs\n",
  );
  const { content } = syncCi(text, { formal: plan({ "formal-a": "" }) });
  assert.equal(
    callerInputs(content)["extra-commands"],
    "node .agents/skills/formal-z/check.mjs\n",
  );
});

test("an existing entry keeps its run, keeps its paths only when there is no record, loses them when the record stops resolving, and stays when no skill folder replaces it, so a sync that keeps stale paths or drops a hand-written check fails", () => {
  const existing = `      formal-checks: |\n        [{"skill": "formal-a", "run": "custom", "paths": ["old.ts"]}, {"skill": "formal-b", "paths": ["old.ts"]}, {"skill": "formal-c", "paths": ["src/a.ts"]}, {"skill": "formal-gone", "run": "node scripts/gone.mjs"}]\n`;
  const { content } = syncCi(withInputs("", existing), {
    formal: plan({
      "formal-a": "",
      "formal-b": COVERAGE("a.ts"),
      "formal-c": COVERAGE("missing.ts"),
    }),
  });
  assert.deepEqual(checksOf(content), [
    { skill: "formal-a", run: "custom", paths: ["old.ts"] },
    { skill: "formal-b", paths: ["src/a.ts"] },
    { skill: "formal-c" },
    { skill: "formal-gone", run: "node scripts/gone.mjs" },
  ]);
});

test("an existing value that is not a JSON array of objects with a skill throws naming ci.yml and the input, so a sync that overwrites it or ignores it fails", () => {
  for (const value of [
    "[",
    '{"skill": "formal-a"}',
    '[{"run": "x"}]',
    '[{"skill": 1}]',
    '[{"skill": "formal-a", "paths": "src/a.ts"}]',
    '[{"skill": "formal-a", "run": 1}]',
    '["formal-a"]',
    "${{ vars.FORMAL }}",
  ])
    assert.throws(
      () =>
        syncCi(withInputs("", `      formal-checks: |\n        ${value}\n`), {
          formal: plan({ "formal-a": "" }),
        }),
      /\.github\/workflows\/ci\.yml: the formal-checks input is not a JSON array/,
      value,
    );
});

test("a repository with no formal skill gets no input and keeps its own caller, so a sync that writes an empty array fails", () => {
  const text = withInputs("", "      renovate-sync: false\n");
  const { content } = syncCi(text, { formal: plan({}) });
  assert.equal(Object.hasOwn(callerInputs(content), "formal-checks"), false);
  const bare = syncCi(workflowWith(""), { formal: plan({}) }).content;
  assert.equal(Object.hasOwn(callerInputs(bare), "formal-checks"), false);
});

test("an entry whose skill folder is gone stays, so a sync that deletes a check the repository ran fails", () => {
  const text = withInputs(
    "",
    '      formal-checks: |\n        [{"skill": "formal-gone"}]\n      renovate-sync: false\n',
  );
  const { content } = syncCi(text, { formal: plan({}) });
  assert.deepEqual(checksOf(content), [{ skill: "formal-gone" }]);
  assert.equal(callerInputs(content)["renovate-sync"], false);
});

test("without a formal plan the jobs and the input are left alone, so a sync that guesses the skills fails", () => {
  const text = withInputs(
    movable("formal-a", "formal-a"),
    '      formal-checks: |\n        [{"skill": "formal-x"}]\n',
  );
  const { content } = syncCi(text);
  assert.notEqual(jobsOf(content)["formal-a"], undefined);
  assert.deepEqual(checksOf(content), [{ skill: "formal-x" }]);
});

test("formalPlan lists the skill folders that hold a check.mjs, sorted, with their SKILL.md and the repository files, so a scan that lists a folder without a check or reads another folder fails", (t) => {
  const root = testRepo(t);
  put(root, ".agents/skills/formal-b/check.mjs", "");
  put(root, ".agents/skills/formal-b/SKILL.md", "b skill");
  put(root, ".agents/skills/formal-a/check.mjs", "");
  put(root, ".agents/skills/formal-nocheck/SKILL.md", "no check");
  put(root, ".agents/skills/unslop/check.mjs", "");
  put(root, "src/a.ts", "");
  commit(root);
  const found = formalPlan(root);
  assert.deepEqual(found.skills, [
    { name: "formal-a", markdown: "" },
    { name: "formal-b", markdown: "b skill" },
  ]);
  assert.ok(found.files.includes("src/a.ts"));
  mkdirSync(`${root}/empty`);
  assert.deepEqual(formalPlan(`${root}/empty`), { skills: [], files: [] });
});
