<!-- antelopejs-guardrails:start -->
<!-- Managed by @antelopejs/tooling-configs. `antelopejs-sync` rewrites everything between these markers; write repository-specific guidance outside them. -->

## Guardrails

CI runs `pnpm run checks` in full on every pull request and reports what failed. The commit hook formats and lints the staged files. Locally, run only the fast check for what you touched:

- `pnpm run typecheck` after you change types or signatures.
- `pnpm exec oxlint <files>` and `pnpm exec oxfmt <files>` on the files you changed.
- One test file, not the suite. In a module that tests with `ajs module test`: `pnpm run build`, then `pnpm exec ajs module test . -f dist/<path>.test.js`.

### Comments

Say it in code: a constraint in a type, a lint rule or a test, a public item's contract in TSDoc. Other comments are lint directives naming their rules, `@ts-expect-error <reason>`, `SAFETY: <reason>` above a type assertion, and license or tool directives. A reason states what the code does now.

### Tests

Each test names the wrong implementation it fails on, or is deleted. Drive behaviour through the public interface. An invariant over many files is a lint rule.

### Review

No tool checks these:

- A type guard checks the nested elements and values it claims.
- A no-upward import rule rejects same-tier peers; probe it with an import.
- A finding only an evasion or a patched internal can trigger goes under Attention and never blocks.

### Suppressions

`guardrails.suppressions.json` caps lint directives, `@ts-expect-error`, `SAFETY:` comments and rules a lint config turns off. Over a cap, fix the code or remove another suppression of that kind; only the operator raises a number. After removing suppressions, run `pnpm run suppressions:update` and commit the file.

<!-- antelopejs-guardrails:end -->
