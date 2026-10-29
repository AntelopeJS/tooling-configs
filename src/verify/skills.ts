import { skillFolder, type VerifyKind } from "./kinds.ts";
import { KIND_TEXT } from "./skill-kinds.ts";

const BIN = "pnpm exec antelopejs-verify";

function bullets(lines: string[]): string {
  return lines.map((line) => `- ${line}`).join("\n");
}

/** The synced SKILL.md of a kind, the part of the skill `antelopejs-sync` owns. */
export function skillText(kind: VerifyKind): string {
  const text = KIND_TEXT[kind];
  const folder = skillFolder(kind);
  return `---
name: verify-${kind}
description: ${JSON.stringify(text.description)}
---

# ${text.title}

${text.user} Every deterministic step is an \`antelopejs-verify\` command: you choose which journeys to run and judge what they show. Never replace a command with a shell recipe. When a journey you need does not exist, add it to \`verify.config.ts\`, name it in its feature file, then run it.

\`antelopejs-sync\` writes this file and \`package.json\` here, and keeps them in sync. Everything else in \`${folder}/\` is the repository's own layer, which sync never touches.

## Launch

\`\`\`bash
${BIN} new --base origin/main --title "<PR title>"
\`\`\`

\`new\` prints the run folder; pass it as \`<run>\` below. ${text.launch} Every journey gets its own \`HOME\` and scratch folder, \`CI=1\`, \`AJS_NO_UPDATE_CHECK=1\`, \`NO_COLOR=1\` and a free port from the kernel, so two runs never share an instance. Run it from the repository root after installing dependencies.

## Doctor

\`\`\`bash
${BIN} doctor <run>
\`\`\`

Doctor checks that HEAD has not moved since \`new\`, \`ajs\` comes from the repository's \`@antelopejs/core\`, the build is newer than \`src/\`, what \`new\` prepared is there, and no process the run recorded is still alive. Do not drive a run that fails doctor.

## Drive

\`\`\`bash
${BIN} plan --base origin/main
${BIN} journey <run> <feature> [journey...]
\`\`\`

\`plan\` maps the diff to features and lists unmapped surfaces. \`journey\` runs a feature's journeys, or the ones named. The pack ships these journeys for this kind; a feature file names them next to the repository's own:

${text.builtins}

## Evidence

Each step writes \`<run>/evidence/<feature>/<journey>/<NN-step>/\` with \`command.txt\`, \`stdout.txt\`, \`stderr.txt\`, \`exit-code.txt\`, \`pid.txt\` for background processes, \`tree.txt\`, \`http.json\` for every request, and \`checks.json\`. \`result.json\` holds a journey's result and \`feature.json\` the merged results of the feature. Read the evidence before you judge a PASS: a check proves only what it asserts.

## Cleanup

\`\`\`bash
${BIN} clean <run>
\`\`\`

\`clean\` stops what the run started, by recorded PID and container name, and removes everything but \`evidence/\` and \`run.json\`. Run it after every run, failed ones included.

## The repository's own layer

- \`verify.config.ts\` default-exports a \`VerifyConfig\` from \`@antelopejs/tooling-configs/verify\`:
  - \`doors\`: one entry per door kind (\`data\`, \`format\`, \`contract\`, \`outbound\`, \`exposure\`, \`publish\`), each \`null\` when it cannot apply or \`{ globs, funnels, containments, why }\`. \`containments\` names the \`feature/journey\` journeys that contain a Data or Format door. Each must fail with that kind's seeded door applied and pass without it: write the journey so one of its checks reads the state the door corrupts.
  - \`journeys\`: the repository's journeys by id, each \`{ title, entryPoint, run(context) }\`, using the check helpers the same import exports.
  - \`env\`, \`setup\` (commands replacing the build), \`userFacing\` (globs replacing the kind's default) and \`formal\` (formal checks: \`name\`, \`covers\`, \`command\`, \`violation\`, and optionally \`behaviour\` and \`baseCommand\`).
${text.layer}
- \`features/<feature>.md\`: frontmatter lists \`covers:\` (source globs), \`docs:\` (pages a verdict judges) and \`journeys:\`, then the sections Sub-features, How to get to it (user POV), Driving it with antelopejs-verify, and Gotchas. \`features/smoke.md\` covers nothing and runs on every verdict; here it runs ${text.smoke}.
- \`seeded-breaks/<feature>.patch\`: one minimal product bug per feature that its journeys must catch.
- \`seeded-doors/<kind>.patch\`: one change per door kind that applies. A Data or Format door's patch must break what its containment journeys check.

\`\`\`bash
${BIN} map
\`\`\`

\`map\` fails on a user-facing file no feature covers, a feature without journeys, docs or seeded break, an unknown journey, an applicable door kind without its seeded door, and a Data or Format door whose \`containments\` name no journey a feature registers. \`containments\` (below) then runs those journeys against the seeded doors.

## Verdict rules

1. **Run every feature whose \`covers:\` globs the diff touches, plus \`smoke\`.** \`plan\` prints that list as \`run\`.
2. **An unmapped surface fails the verdict.** A changed user-facing file no feature covers needs a feature entry, its journeys and its seeded break in the same PR.
3. **Every registered journey of a feature in \`run\` must have run and passed.** Run whole features. A journey that could not reach the product is NOT VERIFIED, and so is the verdict, whatever else passed: never PASS and never PASS+NOTES.
4. **Docs.** Judge every \`docs:\` page of a touched feature against what the journeys showed. A stale page fails the verdict.
5. **Formal checks.** \`${BIN} formal <run>\` runs every formal check of \`verify.config.ts\` that covers the diff and records it under \`evidence/formal/<name>/\`. For each one it decides, without judgement, whether the diff changed what the covered code does. \`emit\` (the default) compares the structure of the covered files' JavaScript on the base and on HEAD: node kinds, names and literal values, leaving out types, comments, formatting, parentheses and \`export\` keywords. Each use of an imported binding stands for its origin (the resolved module and the imported name), so an import retargeted to another module or alias counts as changed; side-effect imports are compared by resolved module, and re-exports of uncovered modules by origin and exported name. Each file must keep its top-level statements in order; function declarations, which are hoisted, may move between covered files with their imports. So a type-only edit, a reformat or a moved function declaration counts as unchanged, while reordering statements or moving any other statement counts as changed. \`emit\` judges behaviour, not the public surface: exports are the api-diff's job. \`probe\` runs the check's \`behaviour.command\` with a worktree of each commit and compares what it prints. Then:
   - a covered check that did not run, or exits non-zero (a tool error, or a check that no longer matches its record), fails the verdict;
   - recorded findings fail the verdict only when the covered behaviour changed; when it did not, the verdict reports them as known findings;
   - when the covered behaviour changed, or the diff changed the check's own \`files\`, \`formal\` also runs the check on the base (\`baseCommand\` when set). A rule the base broke counts as fixed only when HEAD reports it passing (\`passing\`); a rule the base broke that HEAD does not report at all fails the verdict. A change that leaves no violated rule passes.

   The decision never reads the check's output, so a model whose rule names stay the same still fails on a changed behaviour. It is conservative: a local rename or an extracted helper counts as changed, and code outside \`covers\` is invisible to it. \`--all\` also runs the checks that do not cover the diff, without gating.
6. **One-way doors.** The section comes right after the result line and is mandatory. \`${BIN} doors\` prints the \`One-way-door:\` line of the diff. Every file the path rules flag needs a door row or a false positive with its reason. A Data or Format row names a \`containments\` journey that passed in this run, and that journey is proven by \`${BIN} containments\`: it fails with the kind's seeded door applied. A containment that passes with its door contains nothing, so a Data or Format door without one that fails with its door is not contained.
7. **Result.** FAIL if any rule fails. NOT VERIFIED when any journey of a required feature is NOT VERIFIED, for example a SaaS module run without its sandbox keys, however many other journeys passed. PASS+NOTES when everything required ran and passed but the judgement lists something no journey reached or something the owner should look at. PASS otherwise.

Write your judgement to \`<run>/evidence/judgement.json\`:

\`\`\`json
{
  "doors": {
    "none": "why the diff opens no door",
    "rows": [],
    "falsePositives": [{ "kind": "publish", "location": "package.json", "reason": "only devDependencies changed" }]
  },
  "docs": [{ "page": "README.md", "matches": true, "note": "" }],
  "notVerified": ["What no journey reached, and why"],
  "attention": ["What the owner should look at that the journeys cannot judge"],
  "verifier": "the fresh thread that judged this run, not the author"
}
\`\`\`

A door row is \`{ "kind", "location", "irreversible", "containment", "containmentJourney" }\`. Then render and publish:

\`\`\`bash
${BIN} verdict <run> --pr <n>
${BIN} publish <run> --pr <n>
\`\`\`

\`verdict\` writes \`evidence/verdict.md\` and exits 1 unless the result is PASS or PASS+NOTES. \`publish\` commits the evidence to the orphan branch \`verify-evidence\` under \`pr-<n>/<sha>/\` from a temporary worktree, posts the verdict as a PR comment, sets commit status \`verify\` on the head SHA (\`success\` for PASS and PASS+NOTES, \`error\` for NOT VERIFIED, \`failure\` for FAIL) and reads it back. It prints the error GitHub answers when the token cannot write statuses. A new push voids the status. Post a verdict only from a thread that did not write the change.

## Trust

The skill is not Trusted yet. It becomes Trusted when it catches every seeded break, flags every seeded door, fails every Data and Format containment with its door, passes a shadow run of 10 consecutive agent PRs, and its last maintain pass is newer than the last change to the repository or its \`@antelopejs\` dependencies and at most 30 days old.

## Seeded breaks and doors

\`\`\`bash
${BIN} seeded <feature...>
${BIN} seeded-doors
${BIN} containments
\`\`\`

\`seeded\` runs each feature's journeys in a scratch worktree of HEAD without the patch, as the control, and with \`seeded-breaks/<feature>.patch\` applied. It prints \`CAUGHT\` only when a journey that passes in the control fails one of its checks with the patch. Journeys failing in the control and failures without a failing check do not count. \`seeded-doors\` prints \`FLAGGED\` when the path rules flag each patch with its own kind. \`containments\` runs every Data and Format containment journey in a scratch worktree of HEAD without the door, as the control, and with \`seeded-doors/<kind>.patch\` applied. It prints \`CONTAINED\` only when the journey passes in the control and fails one of its checks with the door. \`MISSED\` means it passes with its door, \`UNPROVEN\` that it fails in the control or ends without a failing check, and \`NO-DOOR\` that the kind has no seeded door; the command exits 1 on anything but \`CONTAINED\`.

## Gotchas

${bullets(text.gotchas)}
- Runs live under the system temp folder (\`TMPDIR\`), and the shared caches under \`~/.cache/antelopejs-verify\`.
- A repository that outgrows this skill runs \`antelopejs-sync --verify custom\` and keeps its own \`.agents/skills/verify-<repo>/\`.
`;
}

/** The skill folder's package.json: it makes verify.config.ts an ES module and keeps the folder out of published packages. */
const SKILL_PACKAGE = `${JSON.stringify({ private: true, type: "module" }, null, 2)}\n`;

/** Every file of a kind's synced layer, by path relative to the repository root. */
export function syncedFiles(
  kind: VerifyKind,
): { path: string; content: string }[] {
  return [
    { path: `${skillFolder(kind)}/SKILL.md`, content: skillText(kind) },
    { path: `${skillFolder(kind)}/package.json`, content: SKILL_PACKAGE },
  ];
}
