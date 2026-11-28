---
name: verify-tooling-configs
description: How to check a change in AntelopeJS/tooling-configs before you push it, scoped to what you touched. The command for each kind of change (sync source, presets, lint rules, CLIs, the docs action, ci.yml, skills), the tools and services a test needs, the 4-worker cap, and what ci.yml and the merge queue run instead of you. Use after you edit code, tests, configs or docs here, before you commit or push.
---

# Verify tooling-configs

CI runs every check on every pull request, and the merge queue runs them again on the merged result, Windows included. You check only what you changed.

## Setup

Run once per checkout:

```sh
pnpm install --frozen-lockfile
```

Node 24 (ci.yml also tests the docs action on 22.18.0), pnpm from `packageManager` in `package.json`. The source runs as TypeScript under Node with no build step: `src/bin/*.ts` are the CLIs, and the `pnpm run sync`, `checks` and `typecheck` scripts call them directly. This repo syncs itself, so `pnpm run sync` here runs the sync from your working tree.

## What to run for your change

| You changed | Run |
| --- | --- |
| Any file | `pnpm exec oxlint <files>` and `pnpm exec oxfmt --check <files>`. A Markdown-only change needs nothing else. |
| A `.ts` file under `src` | `pnpm run typecheck`. It checks the whole repo in about 2 s, so it runs whole. |
| Behaviour under `src` | The one test file beside it: `node --test --test-concurrency=4 src/<path>.test.ts`. |
| A test file added, removed or renamed | `pnpm run --silent ci:weights:check`. A new file fails it until `src/ci/test-weights.json` has its weight: the error names the `ci:weights` command that regenerates it from CI artifacts. |
| What `antelopejs-sync` writes (`src/guardrails/sync*.ts`, `ci-*.ts`, `templates.ts`, `agents-block.ts`, `*-skill.ts`, `docs-skills.ts`) | Its test file, then `pnpm run sync:check`. When it reports drift in this repo's own files, run `pnpm run sync` and commit what it wrote. |
| A file the sync writes here (`AGENTS.md` Guardrails block, `lefthook.yml`, `.agents/skills/technical-writing`, `.agents/skills/unslop`) | Nothing by hand. Change the source under `src/guardrails`, then `pnpm run sync`. |
| `.github/workflows/ci.yml` | `pnpm exec oxfmt --check .github/workflows/ci.yml` and `pnpm run sync:check`. Its jobs run only in CI. |
| The docs action (`actions/docs/`) | `npm ci --prefix actions/docs --ignore-scripts --no-audit --no-fund` once, then `node --test --test-concurrency=4 actions/docs/<file>.test.mjs`. |
| A lint directive, `@ts-expect-error` or `SAFETY:` comment | `pnpm run suppressions`. After you remove one, `pnpm run suppressions:update` and commit `guardrails.suppressions.json`. |
| A dependency or `package.json` | `pnpm install`, then the test file of the code that uses it. The lockfile and range checks are CI's. |
| A package export or `tsdown.config.ts` | `pnpm run build`. `size` and `published:types` are CI's. |

## Tools

- oxlint (`oxlint.config.ts`, with the repo's own rules from `src/oxc`), oxfmt (`oxfmt.config.ts`), knip (`knip.config.ts`), lefthook (`lefthook.yml`: the commit hook formats and lints staged files).
- Tests run on `node --test` over `src/**/*.test.ts`. There is no mocha or vitest suite here, though `src/vitest.ts` and the mocha timeout are presets this repo ships.
- `src/guardrails/typescript7-install.test.ts` packs this repo and installs it with npm, pnpm, yarn and bun. Without `bun` on `PATH` its bun cases fail with `spawnSync bun ENOENT`; ci.yml installs bun in the `test` job.

## Services

- MongoDB, only for `src/lease/mongo.test.ts` and the tests that start a lease. The test finds `mongod` on `PATH`, in `MONGOMS_SYSTEM_BINARY` or in `~/.cache/mongodb-binaries`, and skips with that message when none is there. To get one: `node --input-type=module -e 'import { MongoBinary } from "mongodb-memory-server"; console.log(await MongoBinary.getPath())'`, then `MONGOMS_SYSTEM_BINARY=<that path>`. Each test starts and stops its own `mongod`.
- Vale, only for `actions/docs/vale.test.mjs` and `standard.test.mjs`: `VALE_BIN=$(actions/docs/install-vale.sh "$TMPDIR/vale")`.
- No other test needs a service.

## Left to CI

`.github/workflows/ci.yml` runs these. Read their results on your pull request and rerun locally only the scoped command of a failing one:

- `verify`: `pnpm run checks` without `test` (typecheck, lint, format, knip, size, suppressions, `sync:check`, lockfile, dependency, readme and published-types checks), then `ci:weights:check`.
- `test (1)` to `test (8)`: the whole `node --test` suite in 8 shards.
- `docs`: the docs action's tests and the action itself on Node 22.18.0 and 24.
- In the merge queue and the nightly schedule, `verify`, `test` and `docs` again on Windows.
- `ci / checks`, `checks` and `verdict` gather the jobs above. `release.yml` publishes; it runs nothing to check.

## Done

The change is checked when every row its diff touches passed. Name each command you ran and its result in your pull request, and say which checks you left to CI. A row that cannot run, such as a lease test with no `mongod`, says why.
