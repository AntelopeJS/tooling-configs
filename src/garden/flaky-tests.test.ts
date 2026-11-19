import assert from "node:assert/strict";
import test from "node:test";

import { flakyTests } from "./checks/flaky-tests.ts";
import {
  annotation,
  flakyAnnotation,
  queueRun,
  run,
} from "./helpers/builders.ts";
import { FakeApi } from "./helpers/fake-api.ts";
import type { CheckResult, Finding } from "./types.ts";

const RUNS = "/repos/AntelopeJS/mongodb/actions/workflows/ci.yml/runs";

function findings(result: CheckResult): Finding[] {
  assert.equal(result.kind, "findings");
  return result.kind === "findings" ? result.findings : [];
}

function runUrl(id: number): string {
  return `https://github.com/AntelopeJS/x/actions/runs/${id}`;
}

test("a test flaky in several merge-queue runs, twice in one check run and on two check runs of one run, is one finding per repository and test counting each run once, so a check that files one finding per annotation, check run or run fails", async () => {
  const api = new FakeApi()
    .org([{ name: "antelopejs" }, { name: "mongodb" }])
    .mergeQueue(
      "mongodb",
      [queueRun(1, 11, 5), queueRun(2, 12, 30), queueRun(3, 13, 60)],
      {
        11: [
          {
            id: 101,
            annotations: [
              flakyAnnotation("mongodb", "src/a.test.ts > retries"),
              flakyAnnotation("mongodb", "src/a.test.ts > retries"),
            ],
          },
          {
            id: 102,
            annotations: [
              flakyAnnotation("mongodb", "src/a.test.ts > retries"),
              flakyAnnotation("mongodb", "pnpm run test"),
            ],
          },
        ],
        12: [
          {
            id: 103,
            annotations: [
              flakyAnnotation("mongodb", "src/a.test.ts > retries"),
            ],
          },
        ],
        13: [{ id: 104, annotations: [] }],
      },
    )
    .mergeQueue("antelopejs", [queueRun(4, 14, 8)], {
      14: [
        {
          id: 105,
          annotations: [flakyAnnotation("antelopejs", "src/b.test.ts")],
        },
      ],
    });
  const result = findings(await flakyTests.run(api.context()));
  assert.deepEqual(
    result.map(({ key }) => key),
    [
      "antelopejs|flaky-tests|src/b.test.ts",
      "mongodb|flaky-tests|pnpm run test",
      "mongodb|flaky-tests|src/a.test.ts > retries",
    ],
  );
  assert.ok(result.every(({ severity }) => severity === "normal"));
  const [, , retries] = result;
  assert.equal(
    retries.evidence,
    `src/a.test.ts > retries passed only on its merge-queue retry in 2 ci.yml run(s) over the last 14 days, the newest: ${runUrl(1)}, ${runUrl(2)}`,
  );
  assert.equal(
    retries.doneMeans,
    "The test passes without a retry in the merge queue for 14 days.",
  );
  assert.match(result[1].evidence, /in 1 ci\.yml run\(s\)/);
});

test("a message without both the repository prefix and the retry suffix around a test keeps its whole text, so a check that strips each part on its own, strips to an empty test or drops the annotation fails", async () => {
  const messages = [
    "the suite retried itself",
    "AntelopeJS/mongodb: src/a.test.ts",
    "src/b.test.ts passed only on its merge-queue retry.",
    "AntelopeJS/mongodb:  passed only on its merge-queue retry.",
  ];
  const api = new FakeApi()
    .org([{ name: "mongodb" }])
    .mergeQueue("mongodb", [queueRun(1, 11, 5)], {
      11: [
        {
          id: 101,
          annotations: messages.map((message) =>
            annotation("warning", "Flaky test", message),
          ),
        },
      ],
    });
  assert.deepEqual(
    findings(await flakyTests.run(api.context())).map(({ subject }) => subject),
    [...messages].sort(),
  );
});

test("only a warning titled exactly Flaky test is a finding, so a check that matches any warning, any title or any level fails", async () => {
  const message =
    "AntelopeJS/mongodb: src/a.test.ts passed only on its merge-queue retry.";
  const api = new FakeApi()
    .org([{ name: "mongodb" }])
    .mergeQueue("mongodb", [queueRun(1, 11, 5)], {
      11: [
        {
          id: 101,
          annotations: [
            annotation("warning", "Slow test", message),
            annotation("failure", "Flaky test", message),
            annotation("notice", "Flaky test", message),
            annotation("warning", "flaky test", message),
            annotation("warning", "Flaky test: extra", message),
          ],
        },
      ],
    });
  assert.deepEqual(findings(await flakyTests.run(api.context())), []);
});

test("annotations are read only of check runs that report some, so a check that reads every check run fails", async () => {
  const api = new FakeApi()
    .org([{ name: "mongodb" }])
    .mergeQueue("mongodb", [queueRun(1, 11, 5)], {
      11: [
        { id: 101, annotations: [] },
        {
          id: 102,
          annotations: [flakyAnnotation("mongodb", "src/a.test.ts")],
        },
        { id: 103, annotations: [] },
      ],
    });
  await flakyTests.run(api.context());
  const annotations = api.requests.filter((path) =>
    path.includes("/annotations"),
  );
  assert.deepEqual(annotations, [
    "/repos/AntelopeJS/mongodb/check-runs/102/annotations",
  ]);
});

test("a run without a check suite is not read for check runs, so a check that asks for check-suites/undefined fails", async () => {
  const bare = { ...run(1, "success", 5), event: "merge_group" };
  const api = new FakeApi()
    .org([{ name: "mongodb" }])
    .mergeQueue("mongodb", [bare], {});
  assert.deepEqual(findings(await flakyTests.run(api.context())), []);
  assert.ok(api.requests.every((path) => !path.includes("check-suites")));
});

test("the listing asks for completed merge_group runs created in the last 14 days, so a check that lists push runs or another window fails", async () => {
  const api = new FakeApi()
    .org([{ name: "mongodb" }])
    .mergeQueue("mongodb", [], {});
  await flakyTests.run(api.context());
  assert.deepEqual(
    api.requests.filter((path) => path.startsWith(RUNS)),
    [`${RUNS}?event=merge_group&status=completed&created=%3E%3D2026-10-14`],
  );
});

test("a repository without ci.yml is skipped quietly, so a check that lets the listing 404 fail the check fails", async () => {
  const api = new FakeApi().org([{ name: "mongodb" }]);
  assert.deepEqual(findings(await flakyTests.run(api.context())), []);
});

test("a run listed by the day-granular created filter but older than 14 days is neither read nor counted, so a check that trusts the listing alone fails", async () => {
  const api = new FakeApi()
    .org([{ name: "mongodb" }])
    .mergeQueue("mongodb", [queueRun(1, 11, 14 * 24 + 5)], {
      11: [
        {
          id: 101,
          annotations: [flakyAnnotation("mongodb", "src/a.test.ts")],
        },
      ],
    });
  assert.deepEqual(findings(await flakyTests.run(api.context())), []);
  assert.ok(api.requests.every((path) => !path.includes("check-suites")));
});

test("the evidence lists only the 10 newest runs beside the full count and reads every attempt of a run, so a check that lists every URL or reads only the latest attempt fails", async () => {
  const runs = Array.from({ length: 12 }, (_, index) =>
    queueRun(index + 1, 100 + index, 5 + index),
  );
  const suites = Object.fromEntries(
    runs.map((_, index) => [
      100 + index,
      [
        {
          id: 1000 + index,
          annotations: [flakyAnnotation("mongodb", "src/a.test.ts")],
        },
      ],
    ]),
  );
  const api = new FakeApi()
    .org([{ name: "mongodb" }])
    .mergeQueue("mongodb", runs, suites);
  const [only] = findings(await flakyTests.run(api.context()));
  assert.match(only.evidence, /in 12 ci\.yml run\(s\)/);
  assert.ok(only.evidence.includes(runUrl(10)));
  assert.ok(!only.evidence.includes(runUrl(11)));
  assert.ok(
    api.requests.some((path) =>
      path.endsWith("/check-suites/100/check-runs?filter=all"),
    ),
  );
});
