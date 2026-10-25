/** What the managed AGENTS.md block needs to know about the repository. */
export interface AgentsBlockContext {
  profile: "full" | "template";
  ratchet: boolean;
  /** Repository-relative path of the verification skill's SKILL.md, when one exists. */
  verificationSkill: string | undefined;
  /** Repository-relative path of GLOSSARY.md, when one exists. */
  glossary: string | undefined;
}

export const AGENTS_BLOCK_START = "<!-- antelopejs-guardrails:start -->";
export const AGENTS_BLOCK_END = "<!-- antelopejs-guardrails:end -->";

const COMMENTS = `### Comments

Say it in code. A constraint belongs in a type, a lint rule, or a test. A public item's contract belongs in TSDoc (\`/** */\`) on that item. The only other comments are lint directives that name their rules, \`@ts-expect-error <reason>\`, \`SAFETY: <reason>\` above a type assertion, \`/*!\` license headers, and bundler or formatter directives.`;

const TESTS = `### Tests

Hold every test you write or keep to this checklist:

- Name the wrong implementation this test fails on. A test with no answer is deleted, not kept.
- No test reads the file it tests. Drive the behaviour through the public interface.
- An invariant over many files is a lint rule, not a test.`;

const SHARED_RULES = [
  ["Formatting", "oxfmt"],
  ["Lint findings are errors; no rule warns", "oxlint preset"],
  [
    "Comments are TSDoc, directives, or `SAFETY:` only",
    "`antelopejs/no-comments`",
  ],
  ["Every test asserts", "`antelopejs/require-assertion`"],
  [
    "Tests read no files outside fixtures, helpers, locales",
    "`antelopejs/no-fs-read-in-tests`",
  ],
  [
    "No assertion that restates a constant",
    "`antelopejs/no-constant-value-assertion`",
  ],
  [
    'No test whose only check is "is a function"',
    "`antelopejs/no-typeof-function-only-test`",
  ],
  [
    "Params ≤ 5, function ≤ 120 lines, file ≤ 500 lines, depth ≤ 4, complexity ≤ 20",
    "`eslint/max-*`, `eslint/complexity`",
  ],
] as const;

const FULL_RULES = [
  [
    "Files ≤ 20,000 bytes, tests included",
    "`antelopejs-check-size` (pre-commit)",
  ],
  ["Types check", "`tsc` (pre-push)"],
  ["No dead files, exports, or dependencies", "knip"],
  ["Managed files match the pack", "`antelopejs-sync --check`"],
  ["A test names the wrong implementation it catches", "review; no tool"],
] as const;

/** Pads each column the way oxfmt does, so formatting AGENTS.md never reports sync drift. */
function ruleTable(rows: ReadonlyArray<readonly [string, string]>): string {
  const table = [["Rule", "Enforced by"], ...rows];
  const widths = [0, 1].map((column) =>
    Math.max(...table.map((row) => row[column].length)),
  );
  const line = (cells: readonly string[]) =>
    `| ${cells.map((cell, column) => cell.padEnd(widths[column])).join(" | ")} |`;
  const [header, ...body] = table.map(line);
  const divider = line(widths.map((width) => "-".repeat(width)));
  return ["### What enforces what", "", header, divider, ...body].join("\n");
}

function pointers(context: AgentsBlockContext): string[] {
  const lines: string[] = [];
  if (context.verificationSkill !== undefined) {
    lines.push(
      `Prove a change works with the verification skill in [\`${context.verificationSkill}\`](${context.verificationSkill}) before you call it done.`,
    );
  }
  if (context.glossary !== undefined) {
    lines.push(
      `Name things with the terms in [\`${context.glossary}\`](${context.glossary}).`,
    );
  }
  return lines;
}

function fullBody(context: AgentsBlockContext): string[] {
  return [
    "## Guardrails",
    "",
    `Finish every change with \`pnpm run checks\`. It runs typecheck, lint, format, knip, tests, size, ${context.ratchet ? "ratchet, " : ""}and sync, and prints only what failed. The change is done when it prints no failure.`,
    "",
    ...pointers(context).flatMap((line) => [line, ""]),
    "The tools enforce most rules, listed in the table at the end. The sections below hold the rules no tool checks.",
    "",
    COMMENTS,
    "",
    TESTS,
    "",
    ...(context.ratchet
      ? [
          "### Debt",
          "",
          "`guardrails.ratchet.json` records the lint findings and oversize files this repository already had. Its numbers only go down. After you remove debt, run `pnpm run ratchet:update` and commit the lowered file. A rule listed there is off for `oxlint`. The ratchet counts it instead, and the pre-commit hook rejects it on every line you add.",
          "",
        ]
      : []),
    ruleTable([
      ...SHARED_RULES,
      ...FULL_RULES,
      ...(context.ratchet
        ? ([["Existing debt only shrinks", "`antelopejs-ratchet`"]] satisfies [
            string,
            string,
          ][])
        : []),
    ]),
  ];
}

function templateBody(context: AgentsBlockContext): string[] {
  return [
    "## Guardrails",
    "",
    "Lint with `oxlint` and format with `oxfmt`; both read the configs at the repository root. Fix every finding: no rule warns.",
    "",
    ...pointers(context).flatMap((line) => [line, ""]),
    COMMENTS,
    "",
    TESTS,
    "",
    ruleTable(SHARED_RULES),
  ];
}

/** The managed block, markers included, ending with a newline. */
export function agentsBlock(context: AgentsBlockContext): string {
  const body =
    context.profile === "full" ? fullBody(context) : templateBody(context);
  return [
    AGENTS_BLOCK_START,
    "<!-- Managed by @antelopejs/tooling-configs. `antelopejs-sync` rewrites everything between these markers; write repository-specific guidance outside them. -->",
    "",
    ...body,
    "",
    AGENTS_BLOCK_END,
    "",
  ].join("\n");
}
