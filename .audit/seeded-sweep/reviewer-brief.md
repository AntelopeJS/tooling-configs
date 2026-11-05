Inspect only, change no file in any existing checkout, and post nothing on GitHub. You are the independent reviewer of one pull request: {{PR}} in `AntelopeJS/{{REPO}}`, head `{{SHA}}`, base `main`.

## Goal of the PR

Antony removed seeded runs from every AntelopeJS repo on 2026-11-05. The repo's verification skill must end in Lauren's shape: SKILL.md, features/README.md, one file per feature, journeys, verify.config.ts. Formal checks and one-way door detection stay. `@antelopejs/tooling-configs@0.3.0` and `@antelopejs/dms@0.17.0` are released without seeded runs.

Done means:
- `@antelopejs/tooling-configs` at 0.3.0 (and `@antelopejs/dms` at 0.17.0 where the repo uses dms-control, in the root pnpm workspace's manifests, plus any folder SKILL.md runs dms-control from); lockfile updated.
- The repo's `sync` re-run so every managed file matches 0.3.0. An explicit `test-job: false` in ci.yml is allowed when the repo's tests need a build first; the tests must still run inside `ci / checks`. A new `guardrails.ratchet.json`, baseline, suppression or raised ceiling is not allowed: report it as a finding. Splitting an oversize agent file into sibling modules is allowed when it only moves code: check each new file is under 20,000 bytes, every export, journey id, title, step and order is unchanged (compare the registered journey ids before and after), and `map` exits 0. Listing files that `require-tsconfig-include` reports in a tsconfig is allowed, and so are type fixes it forces in tests, scripts, fixtures or config; any change to product code (`src/`, published templates) is a finding. Adding a file that `antelopejs(require-tsconfig-include)` reports to an existing tsconfig `include` is allowed when nothing else changes with it: check that the tsconfig diff only adds those paths. The dms-lang pattern is also allowed: a new composite `playground/tsconfig.config.json` that lists only `antelope.config.ts`, plus a `references` entry to it in `playground/tsconfig.json`.
- `seeded-breaks/`, `seeded-doors/` and containment journeys deleted; `verify.config.ts`, SKILL.md and features no longer mention them; nothing else in the skill changes. A containment journey that a feature lists and that tests real product behaviour stays as an ordinary journey with only its containment label dropped (AntelopeJS/dms#774 made that call). A door row's prose `containment` column stays.
- `pnpm run checks` and CI green on the head. No product code, no other version range changed. No Notion link, session URL or attribution in the PR.
- The PR body has an English snapshot of the goal and done means, and the counts block copied from the removal script's output.

## How

1. In `{{CHECKOUT}}`, run `git fetch origin` and `git worktree add --detach ${TMPDIR:-/tmp}/review-{{REPO}}-{{SHORT}} {{SHA}}`. Work only there.
2. Re-derive the mechanical part. In a second detached worktree at `origin/main`, fetch the script with `gh api -H 'Accept: application/vnd.github.raw' 'repos/AntelopeJS/tooling-configs/contents/.audit/seeded-sweep/remove-seeded.sh?ref=chore/step3-orchestrator' > ${TMPDIR:-/tmp}/remove-seeded-review-{{REPO}}-{{SHORT}}.sh`, check its sha256 is `cdbf043d82ffdd2b65cc02fa35dd2cb710af17b65f2c9a01df5df327cce26c6e`, and run `bash ${TMPDIR:-/tmp}/remove-seeded-review-{{REPO}}-{{SHORT}}.sh .`. Compare its counts with the PR body's `## Removed` block, and compare its diff with the PR's (`git diff origin/main {{SHA}}`). Every difference must be a hand edit that the done means calls for.
3. Read every hand edit. Look for: seeded or containment wording left in the skill, AGENTS.md or docs; wording removed that was not about seeded runs; a journey deleted that a feature still lists, or one kept that only existed as a containment; product code or other version ranges touched; a hand-raised suppression ceiling (a ceiling sync derived from `agentFiles` adoption is allowed); comments that break the repo's AGENTS.md rules.
4. In the head worktree: `pnpm install --frozen-lockfile`, `pnpm run checks`, and the skill's `map` (`pnpm exec antelopejs-verify map`, or the `dms-control map` command its SKILL.md gives). Also run `antelopejs-verify doors` (or the dms-control equivalent) on the diff to show door detection still works. Read `gh pr checks {{PR}}` for CI.
5. Remove both worktrees with `git worktree remove --force` when done.

Block only on what you can show: a failing command at the head, or a line the PR made wrong or left wrong against the done means. Everything else is a nit; list nits separately.

Reply with exactly:
- `VERDICT: CLEAN` or `VERDICT: FINDINGS`
- each finding as `file:line`, what is wrong, the evidence (command and output excerpt)
- nits, if any
- the commands you ran with their exit codes
