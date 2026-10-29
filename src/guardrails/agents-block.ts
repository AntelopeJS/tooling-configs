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

Say it in code. A constraint belongs in a type, a lint rule, or a test. A public item's contract belongs in TSDoc (\`/** */\`) on that item. The only other comments are lint directives that name their rules, \`@ts-expect-error <reason>\`, \`SAFETY: <reason>\` above a type assertion, \`/*!\` license headers, and bundler or formatter directives.

Before suppressing a type rule, try inference or a type derived from its owner with \`Parameters\`, \`ReturnType\`, or indexed access. A private alias can still appear in a published declaration. Keep a suppression only after checking the published contract and the unchecked boundary it protects.

Check each directive reason against the current line and its callers. Returning a value is not the same as awaiting and discarding it. A reason must describe what the code does now.`;

const TESTS = `### Tests

Hold every test you write or keep to this checklist:

- Name the wrong implementation this test fails on. A test with no answer is deleted, not kept.
- No test reads the file it tests. Drive the behaviour through the public interface.
- An invariant over many files is a lint rule, not a test.`;

const CLEANUP_PROOF = `### Cleanup proof

A behaviour-preserving cleanup PR shows \`antelopejs-api-diff <base-ref>\` passing. Published declarations and built runtime exports stay unchanged; pass \`--allow-added <glob>\` (repeatable, e.g. \`'**/internal/**'\`) to let added entries under that glob pass when their module is \`@internal\`, and copy its "Added (allowed)" list. A comment-only PR shows \`antelopejs-comment-proof <base-ref>\` passing instead of a verifier. Both compare committed HEAD.

Copy the proof's whole output into the PR body, down to its closing \`<!-- antelopejs-proof ... -->\` line, which stamps the command, base, committed head and a digest. Never type counts by hand. List the lint findings a PR leaves in place by pasting the block \`antelopejs-body-check --findings\` prints and replacing each \`<why>\`. \`antelopejs-body-check <body.md>\` fails an edited or stale proof block, proof output outside one, and a findings line that is not a live diagnostic at HEAD; counts in prose are not checked, so leave them out. The table counts a lint directive once per rule it names, inline directives included.

Pass \`--probe <file.cjs>\` to api-diff when changing receivers, positional calls, or modules that no published entry reaches. The same captured script runs against both worktree roots, supplied as \`argv[2]\`, and prints JSON observations. Matching metadata alone does not prove those behaviours.

An entry-only rule exempts only its own module. Add a second module entry rather than exempting another importer. A no-upward rule must reject peers in the same tier as well as higher tiers. Probe the rank decision with an import, not just a reading of the configuration.

Moving a method body into a function keeps how it is called: the same receiver, argument count, read order and laziness.

Verify a boundary against the imports a developer or agent would plausibly write: static and dynamic imports, re-exports, Vue \`src\`, CSS \`@import\`, and worker or child-process entries in normally named files. A construction only an evasion would write, an edit to resolution configuration (\`package.json\` \`browser\`, \`exports\`, \`main\` or \`imports\`, bundler aliases, tsconfig \`paths\`), and a difference observable only by patching private fields or internal methods go under Attention and never block. Public API and ordinary subclass behaviour stay part of the contract.`;

const SUPPRESSION_BUDGET = `### Suppression budget

\`guardrails.suppressions.json\` caps the suppressions in authored code: lint directives per rule they name (\`*\` for none), \`@ts-expect-error\`, \`@ts-ignore\` and \`SAFETY:\` comments. A suppression over its ceiling fails: fix the code, or remove another suppression of the same kind. A rule that keeps needing suppressions should be changed in the preset. Never raise or remove a number in that file: the check fails a ceiling higher than on the pull request base, and only the operator approves a raise. A directive disabling \`anti-slop/require-safety-comment-for-type-assertion\` is burn-down debt: remove the assertion, or, where it holds, replace the directive with \`SAFETY: <why it holds>\`, which takes over its room without a raise. After you remove suppressions, run \`pnpm run suppressions:update\` and commit the lowered file.`;

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
    "Tests import the code under test from local source, not their own package name",
    "`antelopejs/no-self-import-in-tests`",
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
  [
    "Cleanup preserves declarations and built runtime export metadata",
    "`antelopejs-api-diff <base-ref>`",
  ],
  [
    "Comment-only changes preserve JavaScript emit",
    "`antelopejs-comment-proof <base-ref>`",
  ],
  [
    "PR-body proof tables are copied unedited from the current head",
    "`antelopejs-body-check <body.md>`",
  ],
  [
    "PR-body findings-left lines are live diagnostics at HEAD",
    "`antelopejs-body-check <body.md>`",
  ],
  [
    "Receiver, positional and unpublished-module behaviour",
    "`antelopejs-api-diff <base-ref> --probe <file.cjs>`",
  ],
  ["Directive and `SAFETY:` reasons are true of the code", "review; no tool"],
  [
    "Evasion-only and patched-internal findings go under Attention",
    "review; no tool",
  ],
  ["No-upward rules reject same-tier peers", "review and import probes"],
  ["No `@ts-ignore`", "`typescript/ban-ts-comment`"],
] as const;

const FULL_RULES = [
  [
    "Files ≤ 20,000 bytes, tests included",
    "`antelopejs-check-size` (pre-commit)",
  ],
  [
    "Suppressions stay within `guardrails.suppressions.json`",
    "`antelopejs-suppressions` (pre-commit, checks)",
  ],
  [
    "No added directive disables the `SAFETY:`, comment or test rules",
    "`antelopejs-suppressions` (pre-commit, checks)",
  ],
  [
    "An added suppression gives a specific reason",
    "`antelopejs-suppressions` (pre-commit, checks)",
  ],
  [
    "A block disable is closed in its file",
    "`antelopejs-suppressions` (pre-commit, checks)",
  ],
  ["Types check", "`tsc` (pre-push)"],
  ["No dead files, exports, or dependencies", "knip"],
  ["Managed files match the pack", "`antelopejs-sync --check`"],
  ["Entry-only rules exempt no tracked outsider", "`antelopejs-sync --check`"],
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
    `Finish every change with \`pnpm run checks\`. It runs typecheck, lint, format, knip, tests, size, ${context.ratchet ? "ratchet, " : ""}suppressions, and sync, and prints only what failed. The change is done when it prints no failure.`,
    "",
    ...pointers(context).flatMap((line) => [line, ""]),
    "The tools enforce most rules, listed in the table at the end. The sections below hold the rules no tool checks.",
    "",
    COMMENTS,
    "",
    TESTS,
    "",
    CLEANUP_PROOF,
    "",
    SUPPRESSION_BUDGET,
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
    CLEANUP_PROOF,
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
