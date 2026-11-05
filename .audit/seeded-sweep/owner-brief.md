You own one pull request in the AntelopeJS repository `AntelopeJS/{{REPO}}`, from build to verified-and-green. You never merge it.

Read `/home/debian/agent-config/t3-pstack/plugins/pstack/skills/poteto-mode/SKILL.md` if it exists on this machine. Your playbook is Autopilot-stack (owner side): build, open the PR, prove it, babysit CI to green, report. The root coordinator thread is `mcp:4665a876-a0be-4d0d-a016-8dcb712ff1b0` on environment `034030e4-3d56-4706-9395-621540f78b87`. Report to it with `t3_thread_send` (pass that `environmentId` and `threadId`). The root, not you, runs the independent review.

## Goal

Antony removed seeded runs from every AntelopeJS repo on 2026-11-05. Seeded runs are not part of Lauren's verification-skill shape (pstack create-/maintain-verification-skill), they slowed every verification, and they drifted from maintain-verification-skill. The tools are already released without them: `@antelopejs/tooling-configs@0.3.0` (`antelopejs-verify` has no `seeded`, `seeded-doors` or `containments`; `map` and `verdict` no longer read breaks, doors or containment journeys) and `@antelopejs/dms@0.17.0` (`dms-control` has no `seeded`). The repository's verification skill must end in Lauren's shape: SKILL.md, features/README.md, one file per feature, journeys, verify.config.ts. Formal checks and one-way door detection (`antelopejs-verify doors`, api-diff `--doors`) stay.

## Done means

- `@antelopejs/tooling-configs` moved to 0.3.0 (and `@antelopejs/dms` to 0.17.0 in dms-* repos and DMS templates where they use dms-control); lockfile updated.
- `antelopejs-sync` (the repo's `sync` script) re-run so the shared verify layer matches 0.3.0.
- `seeded-breaks/`, `seeded-doors/` and containment journeys deleted; `verify.config.ts`, SKILL.md and features no longer mention them; nothing else in the skill changes.
- The repo's `pnpm run checks` and CI green on the PR head.
- A PR against `{{BASE}}` whose body holds an English snapshot of Goal and Done means and the counts it removed, copied from command output.

## Steps

1. You start in a fresh T3 worktree on branch `chore/remove-seeded-runs`. Run `git fetch origin && git reset --hard origin/{{BASE}}` there before anything else, and run every command in that worktree. Print `uptime` once and include the load in your first report.
2. Fetch the script: `gh api -H 'Accept: application/vnd.github.raw' 'repos/AntelopeJS/tooling-configs/contents/.audit/seeded-sweep/remove-seeded.sh?ref=chore/step3-orchestrator' > ${TMPDIR:-/tmp}/remove-seeded-{{REPO}}.sh`. Check `sha256sum` prints `{{SHA}}`, and stop and report if it does not. Never edit or copy-and-change it. Run `bash <script> .` from the worktree root and save its full output to `${TMPDIR:-/tmp}/remove-seeded-{{REPO}}.out`. It bumps the versions in the root pnpm workspace's manifests, installs, runs sync, deletes `seeded-breaks/` and `seeded-doors/`, removes empty `containments: []` entries, fixes the standard features/README sentence, then prints the counts and everything left to judge.
3. Settle every line under `== left to judge ==` by hand:
   - A `containments: [...]` that names journeys: delete the key. A named journey that a feature file lists under `journeys:` and that tests real product behaviour stays as an ordinary feature journey. Drop only its containment label (in titles, TSDoc, feature prose). A journey that exists only as a containment and no feature lists is deleted, with its parts file when nothing else imports it. Keep journey ids and file names otherwise. This is the call Antony made in AntelopeJS/dms#774.
   - A local type or doc field named `containments` in the repo's own `verify.config.ts`: remove it.
   - SKILL.md (custom skills only; sync rewrites shared-kind SKILL.md), features/README.md, feature files, `guard.mjs` and similar: remove the seeded sections, seeded wording in the description, the Trust rule's seeded and containment clauses, the containment rule in the verdict and door sections, and gotchas about seeded or containments. Mirror the 0.3.0 shared SKILL.md and AntelopeJS/dms#774 (`gh pr diff 774 -R AntelopeJS/dms`) for wording. A door row keeps its prose `containment` column; that line stays.
   - Hits that only share the word (seeded test data, a "seeded address", containers) are not seeded runs. Leave them.
   - Manifests outside the root workspace (a skill's `deps/`, a `playground/`, template contents): leave their ranges. Note them in the PR body.
4. Change nothing else. No product code, no version range other than `@antelopejs/tooling-configs` and `@antelopejs/dms`. Keep everything sync wrote. `guardrails.suppressions.json` may gain `agentFiles: true` with ceilings sync derived; that is the tool's adoption step (`raisedCeilings` allows it), so keep it and say so in the PR body, and never raise a number by hand. If the repo seems to need an interface change, stop and report to the root.
5. Prove it on the real artifact: `pnpm run checks` must print no failure. Run the skill's own `map` (`pnpm exec antelopejs-verify map` for shared kinds; the `dms-control map` command SKILL.md gives for custom skills) and check it exits 0. Run `git grep -nIiE 'seeded-(breaks|doors)|containments' -- .agents .claude AGENTS.md docs` and account for every remaining hit. Run `/deslop` and the AGENTS.md comment rules over your hand edits.
6. Commit once: `chore(verify): remove seeded runs from the verification skill`. No attribution trailers. Push the branch, then open the PR against `{{BASE}}` with `gh pr create`. Follow the repo's PR template if it has one. The body opens with `## Why` (the goal in your words), then `## Goal and done means (snapshot)` (the two sections above, in English), `## What changed`, `## Removed` holding the `== remove-seeded counts ==` block copied verbatim from the script output in a fenced block, `## Verification` (the checks summary line and map exit, copied), and `## Attention` (anything a reviewer should look at). No Notion link, no session URL, no "generated by" line anywhere on GitHub. Call `link_pull_request` with the PR URL.
7. Report code-ready to the root: repo, PR URL, head SHA, the counts block, the hand edits you made and why, uptime load.
8. Wait for CI with `watch_pull_request` and end your turn; never poll with sleep or `gh --watch`. Fix a red check on its merits (`/fix-ci` style), rerun step 5, push, and report the new head. When CI is green on the head, call `unwatch_pull_request` and report: `PR <url>, head <sha>, checks green`.
9. The root may send review findings. Fix each verified one, rerun step 5, push, report the new head, and wait for CI again. Never comment on the PR to ask anyone to review, never approve, merge, or push to `{{BASE}}`, never release or publish. Force-push only this branch, with `--force-with-lease`.
10. If you are stuck after two approaches, or a call belongs to Antony, report `BLOCKED: <reason>` to the root and stop.

Keep a short decision log at `.audit/remove-seeded.tsv` in the worktree (uncommitted) with one row per real decision, and paste its rows in your final report.

Your last line is: `PR <full URL>, head <SHA>, checks and reviews <state>`.
