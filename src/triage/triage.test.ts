import assert from "node:assert/strict";
import test from "node:test";

import { createGraphql, type Graphql } from "../garden/api.ts";
import type { JsonObject } from "../garden/json.ts";
import { lines, triage } from "./triage.ts";

interface NodeSpec {
  repo?: string;
  number: number;
  labels?: string[];
  type?: string;
  thumbsUp?: number;
  createdAt?: string;
  body?: string | null;
  linkedOpenPulls?: number;
}

function node(spec: NodeSpec): JsonObject {
  const repo = spec.repo ?? "dms";
  return {
    number: spec.number,
    title: `issue ${spec.number}`,
    url: `https://github.com/AntelopeJS/${repo}/issues/${spec.number}`,
    body: spec.body === undefined ? `body of ${spec.number}` : spec.body,
    createdAt: spec.createdAt ?? "2026-10-01T10:00:00Z",
    repository: { nameWithOwner: `AntelopeJS/${repo}` },
    labels: { nodes: (spec.labels ?? []).map((name) => ({ name })) },
    issueType: spec.type === undefined ? null : { name: spec.type },
    reactions: { totalCount: spec.thumbsUp ?? 0 },
    closedByPullRequestsReferences: { totalCount: spec.linkedOpenPulls ?? 0 },
  };
}

function search(...pages: JsonObject[][]): Graphql & { calls: JsonObject[] } {
  const calls: JsonObject[] = [];
  const graphql = async (_query: string, variables: JsonObject) => {
    calls.push(variables);
    const index = calls.length - 1;
    return {
      search: {
        pageInfo: {
          hasNextPage: index < pages.length - 1,
          endCursor: `cursor-${index}`,
        },
        nodes: pages[index] ?? [],
      },
    };
  };
  return Object.assign(graphql, { calls });
}

test("bugs rank before features before the rest, then by most 👍, then oldest first", async () => {
  const shortlist = await triage(
    search([
      node({ number: 1, labels: ["needs-triage"], thumbsUp: 9 }),
      node({ number: 2, labels: ["feature"], thumbsUp: 5 }),
      node({ number: 3, labels: ["bug"], thumbsUp: 1 }),
      node({
        number: 4,
        labels: ["bug"],
        thumbsUp: 1,
        createdAt: "2026-09-01T10:00:00Z",
      }),
      node({ number: 5, labels: ["bug"], thumbsUp: 3 }),
      node({ number: 6, labels: ["feature"], thumbsUp: 7 }),
    ]),
  );
  assert.deepEqual(
    shortlist.items.map((entry) => `${entry.ref} ${entry.kind}`),
    [
      "AntelopeJS/dms#5 bug",
      "AntelopeJS/dms#4 bug",
      "AntelopeJS/dms#3 bug",
      "AntelopeJS/dms#6 feature",
      "AntelopeJS/dms#2 feature",
      "AntelopeJS/dms#1 other",
    ],
  );
});

test("an issue with a linked open pull request is dropped, and only ten are shown with the count of the rest", async () => {
  const issues = Array.from({ length: 13 }, (_, index) =>
    node({ number: index + 1, labels: ["bug"], thumbsUp: 20 - index }),
  );
  issues.push(
    node({ number: 99, labels: ["bug"], thumbsUp: 50, linkedOpenPulls: 1 }),
  );
  const shortlist = await triage(search(issues));
  assert.equal(shortlist.items.length, 10);
  assert.equal(shortlist.notShown, 3);
  assert.equal(shortlist.items[0].ref, "AntelopeJS/dms#1");
  assert.ok(
    shortlist.items.every((entry) => entry.ref !== "AntelopeJS/dms#99"),
  );
});

test("the label decides the kind, the issue type decides without one", async () => {
  const shortlist = await triage(
    search([
      node({ number: 1, labels: ["feature"], type: "Bug" }),
      node({ number: 2, type: "Bug" }),
      node({ number: 3, type: "Task" }),
    ]),
  );
  assert.deepEqual(
    shortlist.items.map((entry) => `${entry.ref} ${entry.kind}`),
    [
      "AntelopeJS/dms#2 bug",
      "AntelopeJS/dms#1 feature",
      "AntelopeJS/dms#3 other",
    ],
  );
});

test("an item carries its url, title, created date and the body's first line of text", async () => {
  const shortlist = await triage(
    search([
      node({
        number: 7,
        repo: "dms-builder",
        labels: ["bug"],
        createdAt: "2026-11-02T23:30:00Z",
        body: "<!-- template hint -->\n### Package or repository\n\n_No response_\n\n  Saving a page twice loses the draft  \nsecond line",
      }),
      node({
        number: 8,
        labels: ["bug"],
        createdAt: "2026-11-03T10:00:00Z",
        body: null,
      }),
    ]),
  );
  assert.deepEqual(shortlist.items, [
    {
      ref: "AntelopeJS/dms-builder#7",
      url: "https://github.com/AntelopeJS/dms-builder/issues/7",
      kind: "bug",
      title: "issue 7",
      firstLine: "Saving a page twice loses the draft",
      created: "2026-11-02",
    },
    {
      ref: "AntelopeJS/dms#8",
      url: "https://github.com/AntelopeJS/dms/issues/8",
      kind: "bug",
      title: "issue 8",
      firstLine: "",
      created: "2026-11-03",
    },
  ]);
});

test("every page of the search is read with the triage query and the previous cursor", async () => {
  const graphql = search(
    [node({ number: 1, labels: ["bug"] })],
    [node({ number: 2, labels: ["bug"] }), {}],
  );
  const shortlist = await triage(graphql);
  assert.equal(shortlist.items.length, 2);
  assert.equal(graphql.calls.length, 2);
  assert.equal(graphql.calls[1].after, "cursor-0");
  const query = String(graphql.calls[0].q).split(" ");
  for (const qualifier of [
    "org:AntelopeJS",
    "is:issue",
    "is:open",
    "is:public",
    "archived:false",
    "label:needs-triage",
    "no:assignee",
  ])
    assert.ok(query.includes(qualifier), qualifier);
});

test("text output prints one line per item and the count not shown, and nothing when no issue waits", async () => {
  assert.deepEqual(lines({ items: [], notShown: 0 }), []);
  assert.deepEqual(
    lines({
      items: [
        {
          ref: "AntelopeJS/dms#1",
          url: "https://github.com/AntelopeJS/dms/issues/1",
          kind: "bug",
          title: "Broken save",
          firstLine: "",
          created: "2026-11-01",
        },
      ],
      notShown: 4,
    }),
    ["AntelopeJS/dms#1 bug 2026-11-01 Broken save", "4 more not shown"],
  );
});

test("a GraphQL answer that carries errors throws instead of reading as no issues", async (context) => {
  context.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response(
        JSON.stringify({ data: null, errors: [{ message: "rate limited" }] }),
      ),
  );
  await assert.rejects(triage(createGraphql("token")), /rate limited/);
});
