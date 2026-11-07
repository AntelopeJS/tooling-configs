import {
  skillFolder,
  SYNCED_SKILL_FILES,
  type SyncedSkillFile,
  type VerifyKind,
} from "./kinds.ts";
import { DEFAULT_SHARED } from "./map.ts";
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

\`antelopejs-sync\` writes this file, \`package.json\` and \`tsconfig.json\` here, and keeps them in sync. Everything else in \`${folder}/\` is the repository's own layer, which sync never touches.

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

Each step writes \`<run>/evidence/<feature>/<journey>/<NN-step>/\` with \`command.txt\`, \`stdout.txt\`, \`stderr.txt\`, \`exit-code.txt\`, \`pid.txt\` for background processes, \`tree.txt\`, \`http.json\` for every request, and \`checks.json\`. \`result.json\` holds a journey's result and \`feature.json\` the merged results of the feature. A journey id listed under two features runs once per run: when \`journey <run> <feature>\` names no ids and another feature of the run already passed that id at the same HEAD, the feature records a result with \`reusedFrom\` naming that evidence folder and runs nothing. Name the id to run it again. Read the evidence before you judge a PASS: a check proves only what it asserts.

## Cleanup

\`\`\`bash
${BIN} clean <run>
\`\`\`

Each journey deletes its scratch folder and \`HOME\`, its install included, when it ends: passed, failed or interrupted. Only its evidence stays. \`clean\` stops what the run started, by recorded PID and container name, and removes everything but \`evidence/\` and \`run.json\`. Run it after every run, failed ones included.

## The repository's own layer

- \`verify.config.ts\` default-exports a \`VerifyConfig\` from \`@antelopejs/tooling-configs/verify\`:
  - \`doors\`: one entry per door kind (\`data\`, \`format\`, \`contract\`, \`outbound\`, \`exposure\`, \`publish\`), each \`null\` when it cannot apply or \`{ globs, funnels, why }\`.
  - \`journeys\`: the repository's journeys by id, each \`{ title, entryPoint, run(context) }\`, using the check helpers the same import exports. A check states what the product must do; an environment that went away is never a failing check. When a journey fails, the harness reruns each service's readiness command, up to four times over about 3.5 s, and looks at every \`ajs project dev\` the journey started, its own readiness probe included. The journey ends NOT VERIFIED, not FAIL, when a service still fails every rerun, an app was killed by SIGKILL, SIGTERM, SIGHUP or SIGINT that the harness did not send, or the app the harness started failed to bind the port the harness gave it (\`EADDRINUSE\` naming that port), or the first failing step is a registry outage. That step must be a command that exited non-zero or was signalled and that fetches dependencies or images, read from its \`command.txt\` after any \`NAME=value\` prefix and whatever the program's path: \`docker pull\`, \`build\`, \`run\`, \`buildx build\` or \`compose pull\`, \`build\` or \`up\`, \`npm install\`, \`ci\`, \`i\`, \`pack\` or \`view\`, \`pnpm install\`, \`i\`, \`add\`, \`fetch\` or \`update\`, and \`ajs module install\` or \`ajs project init\`, the subcommand right after the program. \`pnpm test\`, \`pnpm run\`, \`sh -c\`, \`node\` and any other command stay FAIL. Every error line of both its streams must then be an outage. The error lines are an \`npm error\` or \`npm ERR!\` line with an error code, a pnpm \`ERR_PNPM_*\` line (after at most one space), a Docker \`docker: ...\` or \`Error response from daemon: ...\` line, and any BuildKit \`ERROR: ...\` line, each at the start of the line. One other error line, such as \`ELIFECYCLE\`, \`failed to solve: process ... did not complete\` or an \`ERR_PNPM_*\` that is not a fetch failure, makes it FAIL, and so do an \`error TS\` line, an \`ELIFECYCLE\` word, a \`✖\` or \`not ok\` test line, npm output indented by a product test, and a line over 8 KiB counted in bytes. The consecutive \`npm error\` lines of one npm error block count together. A line or block is an outage when it has a signal and every request target it names is a known registry. The signal is a registry answer of 5xx or 429 (\`E5xx\` or \`E429\` for npm, \`ERR_PNPM_FETCH_5xx\` or \`ERR_PNPM_FETCH_429\` for pnpm, \`received unexpected HTTP status: 5xx\`, \`toomanyrequests\` or a pull rate limit for Docker), or one of these network causes in any letter case: \`ENOTFOUND\`, \`EAI_AGAIN\`, \`ECONNRESET\`, \`ECONNREFUSED\`, \`ETIMEDOUT\`, \`ERR_SOCKET_TIMEOUT\`, \`socket hang up\`, \`no such host\`, \`server misbehaving\`, \`i/o timeout\`, \`TLS handshake timeout\`, \`tls: handshake failure\`, \`context deadline exceeded\`, \`unexpected EOF\`, \`Temporary failure in name resolution\`, \`Client.Timeout exceeded while awaiting headers\`, \`connection refused\` or \`network is unreachable\` (for pnpm, \`ERR_PNPM_ECONNRESET\` and the like, or \`ERR_PNPM_META_FETCH_FAIL\` with one of them). The request targets are the URL after \`GET\`, \`HEAD\`, \`POST\`, \`PUT\`, \`DELETE\` or \`request to\`, the host after \`lookup\`, the host before the port after \`dial tcp\`, and the address after a network error code. A line with no target, such as a 5xx without a URL, is not an outage, and a host elsewhere on the line is ignored. A target with a port must use 80 or 443 and must be a known registry or a public IPv4 address, so a loopback, private or link-local address, an IPv6 address, \`localhost\` and any other host stay FAIL. The known hosts are \`registry.npmjs.org\`, \`registry.yarnpkg.com\` and \`registry.npmmirror.com\` for npm and pnpm, \`registry-1.docker.io\`, \`docker.io\`, \`auth.docker.io\`, \`index.docker.io\`, \`production.cloudflare.docker.com\` and \`*.r2.cloudflarestorage.com\` for Docker, and \`ghcr.io\`, \`quay.io\`, \`gcr.io\` and \`<label>.gcr.io\`, \`*.pkg.dev\`, \`public.ecr.aws\` and \`*.dkr.ecr.*.amazonaws.com\` for all three. The cause and the step are the NOT VERIFIED reason. A missed outage stays a FAIL, and so do a retry or warning line, a registry error in a step whose command exited 0, a 404 or \`manifest unknown\`, and a product error that only mentions a registry or a timeout. An app that exits on its own with an exit code, one that crashes by another signal such as SIGABRT or SIGSEGV, and one that logs \`EADDRINUSE\` for any other port are the product's failure. A change that takes its own service down still reads as an outage: the service stays down, so the journey is NOT VERIFIED. For anything else the journey depends on, such as a process it started with \`context.command\` or an outside endpoint, probe it when a check fails and call \`context.notVerified(reason)\` when it no longer answers.
  - \`env\`, \`setup\` (commands replacing the build), \`userFacing\` and \`shared\` (globs replacing the kind's default; \`shared\` lists the files whose change runs every feature), and \`formal\` (formal checks: \`name\`, \`covers\`, \`command\`, \`violation\`, and optionally \`behaviour\` and \`baseCommand\`).
${text.layer}
- \`features/README.md\`: the index of the features; \`map\` does not read it as a feature.
- \`features/<feature>.md\`: frontmatter lists \`covers:\` (source globs), \`docs:\` (pages a verdict judges) and \`journeys:\`, then the sections Sub-features, How to get to it (user POV), Driving it with antelopejs-verify, and Gotchas. \`features/smoke.md\` covers nothing and runs on every verdict; here it runs ${text.smoke}.

\`\`\`bash
${BIN} map
\`\`\`

\`map\` fails on a user-facing file no feature covers, a feature without journeys or docs, an unknown journey, and a \`verify.config.ts\` journey no feature names.

## Verdict rules

1. **Run every feature whose \`covers:\` globs the diff touches, plus \`smoke\`.** \`plan\` prints that list as \`run\`. When the diff changes a shared file (${DEFAULT_SHARED[kind].map((glob) => `\`${glob}\``).join(", ")}; \`shared\` in \`verify.config.ts\` replaces this list; files under \`.agents/\`, \`.claude/\` and \`.github/\` never count), \`run\` is every feature, every feature's docs pages are judged, and \`full\` says why. Before a release, create the run with \`new --all\` and plan with \`plan --all\`: every feature runs, whatever the diff.
2. **An unmapped surface fails the verdict.** A changed user-facing file no feature covers needs a feature entry and its journeys in the same PR.
3. **Every registered journey of a feature in \`run\` must have run and passed.** Run whole features. A journey that could not reach the product, or whose environment went away during it (a service that stays down, an app killed from outside, a taken port, a package or image registry that was down or unreachable, shown by the error lines of the first failing command when it installs or pulls), is NOT VERIFIED, and so is the verdict, whatever else passed: never PASS and never PASS+NOTES. Every journey result in the run's evidence counts, also for a feature outside \`run\`: a failed one fails the verdict, because it shows a \`covers:\` glob that misses what the diff broke. A NOT VERIFIED one outside \`run\` is listed under Not verified and caps the result at PASS+NOTES. A journey outside \`run\` that never ran is not required.
4. **Docs.** Judge every page \`plan\` lists as \`docs\` against what the journeys showed: the \`docs:\` pages of the touched features, or of every feature when the full set runs. A stale page fails the verdict.
5. **Formal checks.** \`${BIN} formal <run>\` runs every formal check of \`verify.config.ts\` that covers the diff, or whose own \`files\` the diff changes, and records it under \`evidence/formal/<name>/\`. For each one it decides, without judgement, whether the diff changed what the covered code does. \`emit\` (the default) compares the structure of the covered files' JavaScript on the base and on HEAD: node kinds, names and literal values, leaving out types, comments, formatting, parentheses and \`export\` keywords. Each use of an imported binding stands for its origin (the resolved module and the imported name), so an import retargeted to another module or alias counts as changed; a function declaration refers to the top-level variables and classes of its own file by file and name, so moving it next to a different variable of the same name counts as changed. Exports are keyed by the origin they export, so a re-export or an \`export { f as run }\` retargeted to another binding counts as changed. Each file must keep its top-level statements and its side-effect imports in order; function declarations, which are hoisted, may move between covered files with their imports. So a type-only edit, a reformat or a moved function declaration counts as unchanged, while reordering statements or moving any other statement counts as changed. \`emit\` judges behaviour, not the public surface: exports are the api-diff's job. \`probe\` runs the check's \`behaviour.command\` with a worktree of each commit and compares what it prints. Then:
   - a covered check that did not run, or exits non-zero (a tool error, or a check that no longer matches its record), fails the verdict;
   - recorded findings fail the verdict only when the covered behaviour changed; when it did not, the verdict reports them as known findings;
   - when the covered behaviour changed, or the diff changed the check's own \`files\`, \`formal\` also runs the check on the base (\`baseCommand\` when set). A rule the base broke counts as fixed only when HEAD reports it passing (\`passing\`); a rule the base broke that HEAD does not report at all fails the verdict. A change that leaves no violated rule passes.

   The decision never reads the check's output, so a model whose rule names stay the same still fails on a changed behaviour. It is conservative: a local rename or an extracted helper counts as changed, and code outside \`covers\` is invisible to it. \`--all\` also runs the checks that do not cover the diff, without gating.
6. **One-way doors.** The section comes right after the result line and is mandatory. \`${BIN} doors\` prints the \`One-way-door:\` line of the diff. Every file the path rules flag needs a door row or a false positive with its reason.
7. **Result.** FAIL if any rule fails. NOT VERIFIED when any journey of a required feature is NOT VERIFIED, for example a SaaS module run without its sandbox keys, or a journey whose first failing command ended on a registry outage (an image pull, image build or package install whose every error line is an unreachable or failing known registry), however many other journeys passed. PASS+NOTES when everything required ran and passed but the judgement lists something no journey reached or something the owner should look at. PASS otherwise.

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

A door row is \`{ "kind", "location", "irreversible", "containment" }\`, where \`containment\` says what limits the damage. Then render and publish:

\`\`\`bash
${BIN} verdict <run> --pr <n>
${BIN} publish <run> --pr <n>
\`\`\`

\`verdict\` writes \`evidence/verdict.md\` and exits 1 unless the result is PASS or PASS+NOTES. \`publish\` commits the evidence to the orphan branch \`verify-evidence\` under \`pr-<n>/<sha>/\` from a temporary worktree, posts the verdict as a PR comment, sets commit status \`verify\` on the head SHA (\`success\` for PASS and PASS+NOTES, \`error\` for NOT VERIFIED, \`failure\` for FAIL) and reads it back. It prints the error GitHub answers when the token cannot write statuses. A new push voids the status. Post a verdict only from a thread that did not write the change.

## Trust

The skill is not Trusted yet. It becomes Trusted when it passes a shadow run of 10 consecutive agent PRs and its last maintain pass is newer than the last change to the repository or its \`@antelopejs\` dependencies and at most 30 days old.

## Gotchas

${bullets(text.gotchas)}
- Runs live under the system temp folder (\`TMPDIR\`), and the shared caches under \`~/.cache/antelopejs-verify\`. \`new\` deletes every run no command touched for 7 days, unless a process it recorded is still alive.
- A repository that outgrows this skill runs \`antelopejs-sync --verify custom\` and keeps its own \`.agents/skills/verify-<repo>/\`.
`;
}

/** The skill folder's package.json: it makes verify.config.ts an ES module and keeps the folder out of published packages. */
const SKILL_PACKAGE = `${JSON.stringify({ private: true, type: "module" }, null, 2)}\n`;

/**
 * The skill folder's tsconfig.json: it gives the repository's files there the root compiler options with ES module resolution,
 * so type-aware lint sees real types. The root tsconfig cannot include them: its `rootDir` is usually `src`.
 * `types` names Node: type-aware lint does not discover `@types/node` from this folder, so without it every Node API call
 * in a skill file is error-typed and reported by `typescript/no-unsafe-*` (tooling-configs#93).
 */
const SKILL_TSCONFIG = `${JSON.stringify(
  {
    extends: "../../../tsconfig.json",
    compilerOptions: {
      rootDir: "../../..",
      types: ["node"],
      module: "nodenext",
      moduleResolution: "nodenext",
      allowImportingTsExtensions: true,
      composite: false,
      noEmit: true,
    },
    include: ["**/*.ts"],
  },
  null,
  2,
)}\n`;

/** Every file of a kind's synced layer, by path relative to the repository root. */
export function syncedFiles(
  kind: VerifyKind,
): { path: string; content: string }[] {
  const content: Record<SyncedSkillFile, string> = {
    "SKILL.md": skillText(kind),
    "package.json": SKILL_PACKAGE,
    "tsconfig.json": SKILL_TSCONFIG,
  };
  return SYNCED_SKILL_FILES.map((file) => ({
    path: `${skillFolder(kind)}/${file}`,
    content: content[file],
  }));
}
