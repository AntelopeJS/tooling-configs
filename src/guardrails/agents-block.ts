/** What the managed AGENTS.md block needs to know about the repository. */
export interface AgentsBlockContext {
  profile: "full" | "template";
  /** Repository-relative path of GLOSSARY.md, when one exists. */
  glossary: string | undefined;
}

export const AGENTS_BLOCK_START = "<!-- antelopejs-guardrails:start -->";
export const AGENTS_BLOCK_END = "<!-- antelopejs-guardrails:end -->";

const ITERATION = `CI runs \`pnpm run checks\` in full on every pull request and reports what failed. The commit hook formats and lints the staged files. Locally, run only the fast check for what you touched:

- \`pnpm run typecheck\` after you change types or signatures.
- \`pnpm exec oxlint <files>\` and \`pnpm exec oxfmt <files>\` on the files you changed.
- One test file, not the suite. In a module that tests with \`ajs module test\`: \`pnpm run build\`, then \`pnpm exec ajs module test . -f dist/<path>.test.js\`.`;

const COMMENTS = `### Comments

Say it in code: a constraint in a type, a lint rule or a test, a public item's contract in TSDoc. Other comments are lint directives naming their rules, \`@ts-expect-error <reason>\`, \`SAFETY: <reason>\` above a type assertion, and license or tool directives. A reason states what the code does now.`;

const TESTS = `### Tests

Each test names the wrong implementation it fails on, or is deleted. Drive behaviour through the public interface. An invariant over many files is a lint rule.`;

const REVIEW = `### Review

No tool checks these:

- A type guard checks the nested elements and values it claims.
- A no-upward import rule rejects same-tier peers; probe it with an import.
- A finding only an evasion or a patched internal can trigger goes under Attention and never blocks.`;

const SUPPRESSIONS = `### Suppressions

\`guardrails.suppressions.json\` caps lint directives, \`@ts-expect-error\`, \`SAFETY:\` comments and rules a lint config turns off. Over a cap, fix the code or remove another suppression of that kind; only the operator raises a number. After removing suppressions, run \`pnpm run suppressions:update\` and commit the file.`;

function pointers(context: AgentsBlockContext): string[] {
  const lines: string[] = [];
  if (context.glossary !== undefined) {
    lines.push(
      `Name things with the terms in [\`${context.glossary}\`](${context.glossary}).`,
    );
  }
  return lines;
}

function sections(...parts: string[]): string[] {
  return parts.flatMap((part, index) => (index === 0 ? [part] : ["", part]));
}

function fullBody(context: AgentsBlockContext): string[] {
  return sections(
    "## Guardrails",
    ITERATION,
    ...pointers(context),
    COMMENTS,
    TESTS,
    REVIEW,
    SUPPRESSIONS,
  );
}

function templateBody(context: AgentsBlockContext): string[] {
  return sections(
    "## Guardrails",
    "Lint with `oxlint` and format with `oxfmt`; both read the configs at the repository root. Fix every finding: no rule warns.",
    ...pointers(context),
    COMMENTS,
    TESTS,
    REVIEW,
  );
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
