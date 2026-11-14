import assert from "node:assert/strict";
import test from "node:test";

import { ApiError, createApi } from "./api.ts";
import { PartialFailure, type Check } from "./check.ts";
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
    checks,
  });
  const second = await garden(new FakeApi().org([]), {
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
    checks: [urgent],
  });
  assert.deepEqual(failureLines(outcome), [
    "URGENT mongodb advisories GHSA-1: critical in undici",
  ]);
});

async function failureOf(): Promise<ApiError> {
  const error = await createApi("token")
    .json("/orgs/AntelopeJS/rulesets")
    .catch((caught: unknown) => caught);
  assert.ok(error instanceof ApiError);
  return error;
}

test("a refused GitHub read names the scope the classic token lacks", async (context) => {
  context.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response("{}", {
        status: 404,
        headers: {
          "X-Accepted-OAuth-Scopes": "admin:org",
          "X-OAuth-Scopes": "gist, read:org, repo, workflow",
        },
      }),
  );
  const error = await failureOf();
  assert.deepEqual(error.missingScopes, ["admin:org"]);
  assert.match(error.message, /lacks the admin:org scope/);
});

test("a refused GitHub read names no scope when the token holds an accepted one or lists none", async (context) => {
  const answers: { [name: string]: string }[] = [
    {
      "X-Accepted-OAuth-Scopes": "admin:org, read:org",
      "X-OAuth-Scopes": "read:org",
    },
    { "X-Accepted-OAuth-Scopes": "admin:org" },
  ];
  context.mock.method(
    globalThis,
    "fetch",
    async () => new Response("{}", { status: 404, headers: answers.shift() }),
  );
  assert.deepEqual((await failureOf()).missingScopes, []);
  assert.deepEqual((await failureOf()).missingScopes, []);
});
