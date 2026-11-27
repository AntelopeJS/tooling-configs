import assert from "node:assert/strict";
import test from "node:test";

import { coveragePaths } from "./ci-coverage-record.ts";
import { fixture } from "./helpers/ci-text.ts";

const SKILL = "formal-x";
const FILES = [
  "src/engine.ts",
  "src/records.ts",
  "src/transitions.ts",
  "src/clock.ts",
  "src/triggers.ts",
  "src/dialect/a/shared.ts",
  "src/dialect/b/shared.ts",
  ".agents/skills/formal-x/check.mjs",
  ".agents/skills/formal-x/server.ts",
];

function record(heading: string, ...rows: string[]): string {
  return `# Formal check\n\n${heading}\n\n| Model | Code |\n| --- | --- |\n${rows.join("\n")}\n\nAfter.\n`;
}

test("the files of a coverage record table are its paths, sorted and deduplicated, with a line suffix dropped, so a parser that keeps `:24-64` or lists a file twice fails", () => {
  const markdown = record(
    "## Coverage record",
    "| `Init` | records.ts:24-64 and engine.ts:9 |",
    "| `Tick` | `transitions.ts`, `src/engine.ts:166-180` |",
  );
  assert.deepEqual(coveragePaths(markdown, FILES, SKILL), [
    "src/engine.ts",
    "src/records.ts",
    "src/transitions.ts",
  ]);
});

test("the payment-subscriptions record resolves to the five files its table names, so a parser that reads the description or the prose bullets instead of the table fails", () => {
  const files = [
    "src/clock.ts",
    "src/engine.ts",
    "src/implementation.ts",
    "src/records.ts",
    "src/transitions.ts",
    "src/triggers.ts",
  ];
  assert.deepEqual(
    coveragePaths(
      fixture("payment-subscriptions-formal-billing-lease.SKILL.md"),
      files,
      "formal-billing-lease",
    ),
    [
      "src/clock.ts",
      "src/engine.ts",
      "src/records.ts",
      "src/transitions.ts",
      "src/triggers.ts",
    ],
  );
});

test("a token with no file leaves no paths at all, so a parser that narrows to the tokens it resolved fails", () => {
  const markdown = record(
    "## Coverage record",
    "| `Init` | engine.ts:1 |",
    "| `Tick` | missing.ts:9-11 |",
  );
  assert.equal(coveragePaths(markdown, FILES, SKILL), undefined);
});

test("a bare name that matches two files leaves no paths, and a full path or a unique suffix resolves, so a parser that takes the first match fails", () => {
  const ambiguous = record("## Coverage record", "| `A` | shared.ts:1 |");
  assert.equal(coveragePaths(ambiguous, FILES, SKILL), undefined);
  const exact = record(
    "## Coverage record",
    "| `A` | src/dialect/a/shared.ts:1, a/shared.ts |",
  );
  assert.deepEqual(coveragePaths(exact, FILES, SKILL), [
    "src/dialect/a/shared.ts",
  ]);
});

test("a file of the skill's own folder is left out and does not spoil the rest, so a parser that lists it or treats it as unresolved fails", () => {
  const markdown = record(
    "## Coverage record",
    "| `A` | server.ts, engine.ts |",
    "| `B` | check.mjs |",
  );
  assert.deepEqual(coveragePaths(markdown, FILES, SKILL), ["src/engine.ts"]);
  const onlyOwn = record("## Coverage record", "| `A` | server.ts |");
  assert.equal(coveragePaths(onlyOwn, FILES, SKILL), undefined);
});

test("the header and separator rows and the lines outside the table are skipped, so a parser that reads the whole section fails", () => {
  const markdown = `## Coverage record\n\nSee clock.ts in prose.\n\n| header.ts | Code |\n| --- | --- |\n| \`A\` | engine.ts |\n\n- bullet.ts\n`;
  assert.deepEqual(coveragePaths(markdown, FILES, SKILL), ["src/engine.ts"]);
});

test("Coverage record wins over Scope and assumptions, and either heading may be level 2 or 3, so a parser that reads the first table of the file fails", () => {
  const both = `## Scope and assumptions\n\n| A | B |\n| --- | --- |\n| x | clock.ts |\n\n### Coverage record\n\n| A | B |\n| --- | --- |\n| x | engine.ts |\n`;
  assert.deepEqual(coveragePaths(both, FILES, SKILL), ["src/engine.ts"]);
  const scope = `### Scope and assumptions\n\n| A | B |\n| --- | --- |\n| x | clock.ts |\n`;
  assert.deepEqual(coveragePaths(scope, FILES, SKILL), ["src/clock.ts"]);
});

test("a section ends at the next heading of its level or above and ignores a heading inside a code fence, so a parser that reads to the end of the file fails", () => {
  const markdown = `## Coverage record\n\n| A | B |\n| --- | --- |\n| x | engine.ts |\n\n\`\`\`sh\n# not a heading\n\`\`\`\n\n| A | B |\n| --- | --- |\n| x | records.ts |\n\n## Next\n\n| A | B |\n| --- | --- |\n| x | clock.ts |\n`;
  assert.deepEqual(coveragePaths(markdown, FILES, SKILL), [
    "src/engine.ts",
    "src/records.ts",
  ]);
});

test("a record without the heading, without a table or without a source file gives no paths, so a parser that returns an empty list fails", () => {
  assert.equal(coveragePaths("# Only a title\n", FILES, SKILL), undefined);
  assert.equal(
    coveragePaths("## Coverage record\n\nProse only.\n", FILES, SKILL),
    undefined,
  );
  assert.equal(
    coveragePaths(
      record("## Coverage record", "| `A` | docs only |"),
      FILES,
      SKILL,
    ),
    undefined,
  );
});

const DATABASE = "src/implementations/database";

test("mysql's change-feed record resolves its folder-local names to the skill folder and keeps the module files, so a parser that reads server.ts or check.ts as unresolved fails", () => {
  const skill = "formal-change-feed-delivery";
  const folder = `.agents/skills/${skill}`;
  const files = [
    `${DATABASE}/feeds.ts`,
    `${DATABASE}/feed-poll.ts`,
    `${DATABASE}/sequencer.ts`,
    `${DATABASE}/reaper.ts`,
    `${DATABASE}/change-loop.ts`,
    "src/dialect/mysql/capture.ts",
    ...["check.mjs", "check.ts", "server.ts", "statements.ts", "steps.ts"].map(
      (file) => `${folder}/${file}`,
    ),
    ".agents/skills/formal-other/check.ts",
    ".agents/skills/formal-other/server.ts",
  ];
  assert.deepEqual(
    coveragePaths(
      fixture("mysql-formal-change-feed-delivery.SKILL.md"),
      files,
      skill,
    ),
    [
      "src/dialect/mysql/capture.ts",
      `${DATABASE}/change-loop.ts`,
      `${DATABASE}/feed-poll.ts`,
      `${DATABASE}/feeds.ts`,
      `${DATABASE}/reaper.ts`,
      `${DATABASE}/sequencer.ts`,
    ],
  );
});

test("mysql's json-value record resolves bare names by their unique suffix next to full paths, so a parser that needs a full path fails", () => {
  const files = [
    "src/dialect/mysql/sql-json.ts",
    "src/dialect/mysql/sql-json-kinds.ts",
    "src/dialect/mysql/flavour.ts",
    "src/dialect/mariadb/numbers.ts",
    "src/dialect/mariadb/json-text.ts",
    ...[
      "stages-aggregate",
      "stages-group",
      "grouped",
      "join-key",
      "value-key",
      "ranked-key",
    ].map((name) => `${DATABASE}/${name}.ts`),
  ];
  assert.deepEqual(
    coveragePaths(
      fixture("mysql-formal-json-value-identity.SKILL.md"),
      files,
      "formal-json-value-identity",
    ),
    files.toSorted(),
  );
});

test("mysql's pipeline-chains record names no source file, so a parser that invents paths from its prose fails", () => {
  assert.equal(
    coveragePaths(
      fixture("mysql-formal-pipeline-chains.SKILL.md"),
      FILES,
      "formal-pipeline-chains",
    ),
    undefined,
  );
});
