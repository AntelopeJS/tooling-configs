# @antelopejs/tooling-configs

<div align="center">
<a href="https://www.npmjs.com/package/@antelopejs/tooling-configs"><img alt="npm" src="https://img.shields.io/npm/v/@antelopejs/tooling-configs?style=for-the-badge&labelColor=000000&color=000000"></a>
<a href="./LICENSE"><img alt="License" src="https://img.shields.io/npm/l/@antelopejs/tooling-configs?style=for-the-badge&labelColor=000000&color=000000"></a>
<a href="https://discord.gg/sjK28QHrA7"><img src="https://img.shields.io/badge/Discord-18181B?logo=discord&style=for-the-badge&color=000000" alt="Discord"></a>
</div>

The AntelopeJS guardrail pack: shared lint, format and dead-code presets, the commands that install and enforce them in a repository, and a check for the version ranges of interface dependencies.

- [oxlint](https://oxc.rs) and [oxfmt](https://oxc.rs) replace Biome: lint, format and Tailwind class sorting, `.vue` included.
- ESLint stays for the Nuxt front ends, from a shared config, until oxlint lints `.vue` files.
- [Knip](https://knip.dev) learns the entry points of an AntelopeJS module.
- Every preset is a function: options adjust it without copying it.
- `antelopejs-sync` writes the configs, hooks, scripts and agent instructions into a repository, and `antelopejs-sync --check` fails CI when they drift.
- Every lint rule is an error or off. Existing debt is recorded per repository and may only shrink.

## What's in the box

| Export             | Import                                                                    | What it gives                                                               |
| ------------------ | ------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `./oxc/lint`       | `import { antelopePreset } from "@antelopejs/tooling-configs/oxc/lint"`   | The oxlint preset                                                           |
| `./oxc/fmt`        | `import { antelopeFmtPreset } from "@antelopejs/tooling-configs/oxc/fmt"` | The oxfmt preset (house style)                                              |
| `./eslint`         | `import { antelopeNuxtConfig } from "@antelopejs/tooling-configs/eslint"` | ESLint for Nuxt layers                                                      |
| `./knip`           | `import { antelopeKnipConfig } from "@antelopejs/tooling-configs/knip"`   | Knip for AntelopeJS modules                                                 |
| `./oxc/anti-slop`  | Loaded by the oxlint preset as a JS plugin                                | The vendored [anti-slop](https://github.com/dmmulroy/anti-slop) rules       |
| `./oxc/guardrails` | Loaded by the oxlint preset as a JS plugin                                | The `antelopejs` comment and test-quality rules                             |
| bin                | `antelopejs-sync`                                                         | Writes the guardrail pack into a repository; `--check` reports drift        |
| bin                | `antelopejs-checks`                                                       | Runs every check and prints only the failures                               |
| bin                | `antelopejs-ratchet`                                                      | Fails when recorded debt grows; `--update` lowers the record                |
| bin                | `antelopejs-check-size`                                                   | Fails on authored files over 20,000 bytes and on blanket disable directives |
| bin                | `antelopejs-api-diff <base-ref>`                                          | Compares published declaration bundles against committed HEAD               |
| bin                | `antelopejs-comment-proof <base-ref>`                                     | Compares comment-free JavaScript emit against committed HEAD                |
| bin                | `antelopejs-check-interface-ranges`                                       | Fails on interface ranges that break module startup                         |

## Install

Node.js 24, or at least 22.18: oxlint reads `oxlint.config.ts` and loads JS plugins by executing TypeScript.

```bash
pnpm add -D @antelopejs/tooling-configs oxlint@1.81.0 oxfmt
```

The tools are optional peer dependencies, so add only the ones a repository uses:

| Tool                    | Packages to add                                                                  |
| ----------------------- | -------------------------------------------------------------------------------- |
| oxlint                  | `oxlint@1.81.0`, plus `oxlint-tsgolint` for the type-aware rules (on by default) |
| oxfmt                   | `oxfmt@^0.66.0`                                                                  |
| ESLint                  | `@nuxt/eslint-config`                                                            |
| Knip                    | `knip@>=6`                                                                       |
| Import sorting (opt-in) | `eslint-plugin-perfectionist`                                                    |

Pin `oxlint` to the exact version this package uses for `@oxlint/plugins` (currently **1.81.0**): the JS plugin API is still alpha and the two must move together.

## oxlint

```ts
// oxlint.config.ts
import { defineConfig } from "oxlint";
import { antelopePreset } from "@antelopejs/tooling-configs/oxc/lint";

export default defineConfig({
  extends: [antelopePreset()],
  // oxlint reads this field only from the root config, never from a preset.
  options: { typeAware: true },
});
```

```jsonc
// package.json
{
  "scripts": {
    "lint": "oxlint",
    "lint:fix": "oxlint --fix",
  },
}
```

### What the preset turns on

| Group          | Rules                                                                                                                                                                                                             | Default |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| oxc            | the `correctness` category, with the `eslint`, `typescript`, `node`, `oxc`, `import` and `promise` plugins; `no-unused-vars` (`_` prefix allowed), `eqeqeq` (`== null` allowed), `radix`, `prefer-regex-literals` | error   |
| Imports        | `import/no-cycle`, `import/no-self-import`, `import/no-duplicates`                                                                                                                                                | error   |
| Type-aware     | `typescript/no-floating-promises` and eight more type-aware rules                                                                                                                                                 | error   |
| Complexity     | `max-params` 5, `max-lines-per-function` 120, `max-lines` 500, `max-depth` 4, `complexity` 20                                                                                                                     | error   |
| Anti-slop      | all 15 vendored rules                                                                                                                                                                                             | error   |
| Guardrails     | `antelopejs/no-comments`; in test files `antelopejs/no-fs-read-in-tests`, `antelopejs/no-constant-value-assertion`, `antelopejs/no-typeof-function-only-test` and `antelopejs/require-assertion`                  | error   |
| Import sorting | `perfectionist/sort-imports`, autofixed by `oxlint --fix`                                                                                                                                                         | off     |

No rule warns. oxlint reports `correctness` as warnings by default, and warnings never fail the command, so the preset raises it to error. A repository with existing findings records them in `guardrails.ratchet.json` instead of lowering a severity (see [Guardrail pack](#guardrail-pack)).

The guardrail rules:

| Rule                                      | Fails on                                                                                                                                                                                                                                                                                                                                  |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `antelopejs/no-comments`                  | `//` and `/* */` comments. Allowed: TSDoc `/** */`, `SAFETY: <reason>` (one block, or a run of `//` lines), `/*!` license headers, `@ts-expect-error <reason>`, oxlint/eslint directives that name their rules, `/// <reference />`, `#__PURE__`/`@__PURE__`, `@vite-ignore` and webpack magic comments, `prettier-ignore`/`oxfmt-ignore` |
| `antelopejs/no-fs-read-in-tests`          | `readFileSync` or `readdirSync` from `fs` in a test file. Files under `fixtures/`, `helpers/` and `locales/` may read                                                                                                                                                                                                                     |
| `antelopejs/require-assertion`            | a test with no assertion. Counts: calls named `expect*` or `assert*`, `sinon.assert.*`, supertest `.expect(...)`, and should-style `x.should…` or `should(x)`                                                                                                                                                                             |
| `antelopejs/no-constant-value-assertion`  | `expect(X).toBe(literal)` where the root of `X` is an UPPER_SNAKE constant (`MAX_ITEMS`, `NAMES.if`, not `process.env.NODE_ENV`); also `.toEqual`, `.to.equal`, `.to.eq`, `.eql` and synonyms                                                                                                                                             |
| `antelopejs/no-typeof-function-only-test` | a test whose only assertions are `toBeTypeOf("function")`, `to.be.a("function")` or equivalents                                                                                                                                                                                                                                           |

Test files are `*.test.*`, `*.spec.*`, and files under `test/`, `tests/` and `__tests__/`, whatever the framework. The preset keeps four framework-neutral Jest-plugin rules: `no-disabled-tests`, `no-focused-tests`, `valid-describe-callback` and `valid-title`.

Import sorting is off because it moves value imports across side-effect imports, and in an AntelopeJS module `import "./components"` is what registers the decorated classes. Turn it on only where import order does not matter.

### Options

```ts
antelopePreset({
  antiSlop: false, // true (default)
  guardrails: false, // true (default)
  importCycles: false, // true (default)
  complexity: { maxParams: 8 }, // override thresholds, or false
  importSorting: true, // false (default); needs eslint-plugin-perfectionist
  typeAware: false, // true (default); false when the repository has no oxlint-tsgolint
});
```

### Add ignore patterns

oxlint does not merge `ignorePatterns` across `extends`: a root config that declares its own replaces the preset's. Spread the shared ones:

```ts
// oxlint.config.ts
import { defineConfig } from "oxlint";
import {
  ANTELOPE_IGNORE_PATTERNS,
  antelopePreset,
} from "@antelopejs/tooling-configs/oxc/lint";

export default defineConfig({
  extends: [antelopePreset()],
  ignorePatterns: [...ANTELOPE_IGNORE_PATTERNS, "playground/**"],
});
```

## Guardrail pack

Run `antelopejs-sync` at the repository root, then install dependencies. It is idempotent: a second run changes nothing.

```bash
pnpm add -D @antelopejs/tooling-configs oxlint@1.81.0 oxlint-tsgolint oxfmt
pnpm exec antelopejs-sync
pnpm install
```

| File                                                    | What `sync` does                                                                                                                                                                                      |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `oxlint.config.ts`, `oxfmt.config.ts`, `knip.config.ts` | Writes a config that extends the preset, unless the file already imports it                                                                                                                           |
| `lefthook.yml`                                          | Pre-commit on staged files: oxfmt, oxlint, size. Pre-push: typecheck                                                                                                                                  |
| `package.json`                                          | `prepare` installs lefthook. Sets `checks`, `size`, `ratchet`, `ratchet:update`, `sync`, `sync:check`; adds missing `typecheck`, `lint`, `format`, `format:check`, `knip`; adds `lefthook` and `knip` |
| `.nvmrc`                                                | `24`                                                                                                                                                                                                  |
| `.agents/setup`                                         | Orb setup: switches to the `.nvmrc` Node, activates `packageManager` through corepack, installs with the frozen lockfile                                                                              |
| `AGENTS.md`                                             | Writes the managed block between `<!-- antelopejs-guardrails:start -->` and `:end -->`; text outside the markers stays                                                                                |
| `CLAUDE.md`                                             | `@AGENTS.md`                                                                                                                                                                                          |
| `guardrails.ratchet.json`                               | Records non-empty debt on first adoption, before `sync:check` exists                                                                                                                                  |

`--profile template` writes only the three preset configs and a user-facing `AGENTS.md` block, for template repositories. `antelopejs-sync --check` writes nothing and exits 1 on any drift; `pnpm run checks` runs it.

`pnpm run checks` runs `typecheck`, `lint`, `format:check`, `knip`, `test`, `size` and `sync:check`, plus `ratchet` when `guardrails.ratchet.json` exists. It prints only the output of the steps that failed. Sync adds the ratchet scripts and pre-commit hook only while that file exists.

### Ratchet

`guardrails.ratchet.json` holds the debt a repository had when it adopted the pack:

```json
{
  "rules": { "antelopejs/no-comments": 22, "eslint/max-depth": 1 },
  "oversizeFiles": { "src/legacy.ts": 31250 }
}
```

- A rule listed under `rules` is off for `oxlint`, so editors, hooks and `lint` stay green. `antelopejs-ratchet` counts it with every rule on, and fails when a count rises. It prints the findings in the files the change touched.
- A file listed under `oversizeFiles` may exceed 20,000 bytes and `max-lines`, up to its recorded size. Any other file over either limit fails. When git sees a listed file renamed (`git mv`, or a staged delete and add), the allowance moves to the new path and never exceeds the old one; a copy or a new file inherits nothing. `antelopejs-ratchet --base <ref>` detects renames against that revision instead of `HEAD`, for a rename that was committed before the file was updated.
- `antelopejs-ratchet --update` lowers each number to the current count and removes what reached zero. It never raises a number or adds an entry. Commit the lowered file.

When every rule count is zero and `oversizeFiles` is empty, the ratchet is retired. `antelopejs-ratchet --update` deletes the file and asks you to run `antelopejs-sync`. Sync then removes `ratchet`, `ratchet:update`, the ratchet hook and the Debt instructions. Commit those changes together. An empty baseline on first adoption creates no file. Later syncs never recreate it because the `sync:check` script marks adoption.

`antelopejs-sync --check` rejects an existing retired file and tells you to run `ratchet:update`. Plain sync reports the same note but leaves deletion to the update command.

### Size

`antelopejs-check-size` fails on an authored file over 20,000 bytes, tests included. Generated code (`dist`, `coverage`, `.nuxt`, `.output`, and `build` or `output` at the repository root or a package root, never under `src/` or `test/`), fixtures, lockfiles, `CHANGELOG.md`, Markdown and binary assets are excluded. Data JSON under `locales/` or `i18n/`, `blocks.json`, `schema.json`, and `evals/**/cases.json` are excluded too. Files over the limit with a NUL byte in their first 8,000 bytes are binary even without a known extension. Staged checks inspect the index blob. Excluded files are also removed from recorded size allowances on ratchet update.

Pass paths to check only those files, as the pre-commit hook does. The command also fails on an `oxlint-disable` or `eslint-disable` directive (line, next-line or file form) that names no rule: oxlint applies such a directive before any rule runs, so `no-comments` cannot report it.

### Cleanup proof

A behaviour-preserving cleanup PR shows `antelopejs-api-diff <base-ref>` passing. It checks each tracked, non-private package with a `tsconfig.json`, using that package's installed TypeScript. It emits declarations without comments, resolves published entries from `exports` (preferring `types`), `main`, `types`/`typings` and `typesVersions`, and bundles each entry's local declaration closure. External packages stay external. Stable top-level ordering ignores declaration moves between internal files while preserving overload order. Compiler errors fail the proof.

A comment-only PR shows `antelopejs-comment-proof <base-ref>` passing instead of a verifier. It includes private packages, ignores type diagnostics and compares comment-free JavaScript emit byte for byte. Both commands exclude test sources, fail on added or removed outputs, and print unified diffs for changes.

Pass `--allow-added <glob>` (repeatable) to `antelopejs-api-diff` when a refactor adds helper files that a wildcard export publishes, such as an `internal/` directory under `"./*"`. An added entry passes, in both the declaration and the runtime half, when its published subpath matches a glob (for example `--allow-added '**/internal/**'`, matched against `base/table-view/internal/helper` for `./base/table-view/internal/helper`) and its source module is marked `@internal`: a leading `/** @internal @packageDocumentation */` comment on the module (`@module` and `@fileoverview` also qualify), or an `@internal` tag on every exported declaration. Allowed entries are printed under `Added (allowed): <count>`. An added entry that matches but is not marked `@internal` fails with the file and the fix. Added entries matching no glob, removed entries and changed entries still fail, matching or not. Without the flag nothing changes.

```bash
pnpm exec antelopejs-api-diff origin/main --allow-added '**/internal/**'
```

Both commands compare **committed HEAD**, not staged or working-tree edits. They check out the base and HEAD in temporary detached worktrees, reuse the current checkout's root and package `node_modules`, and remove the worktrees afterwards. Install the consumer's dependencies before running them.

```bash
pnpm exec antelopejs-api-diff origin/main
pnpm exec antelopejs-comment-proof origin/main
```

## oxfmt

```ts
// oxfmt.config.ts
import { antelopeFmtPreset } from "@antelopejs/tooling-configs/oxc/fmt";

export default antelopeFmtPreset();
```

```jsonc
// package.json
{
  "scripts": {
    "format": "oxfmt .",
    "format:check": "oxfmt --check .",
  },
}
```

The house style sets every field, so `.editorconfig` files cannot override it: `printWidth` 80, 2 spaces, semicolons, double quotes, `trailingComma: "all"`. Fix the repository's `.editorconfig` to match anyway, so editors agree with the formatter.

The preset leaves import order to the linter and ignores `CHANGELOG.md`, which changelogen writes unformatted on every release. Other options of oxfmt pass through. Two are specific:

```ts
// oxfmt.config.ts
export default antelopeFmtPreset({
  ignorePatterns: ["frontend-vue/**"], // added to the shared ignores, not replacing them
  tailwindStylesheet: "./assets/css/main.css", // sorts Tailwind classes, replacing prettier-plugin-tailwindcss
});
```

### Replace Biome

Delete `biome.json` and the `@biomejs/biome` dependency, point `lint`, `lint:fix` and `format` at oxlint and oxfmt, and port what the Biome config carried that the preset does not. Reformat in its own commit and list it in `.git-blame-ignore-revs`, which GitHub honours.

## ESLint (Nuxt front ends)

oxlint does not lint `.vue` files yet, so the front end stays on ESLint:

```js
// frontend-vue/eslint.config.mjs
import { antelopeNuxtConfig } from "@antelopejs/tooling-configs/eslint";

export default antelopeNuxtConfig({ dirs: ["./playground"] });
```

`@nuxt/eslint-config` supplies the Vue and TypeScript rules. The preset only records where AntelopeJS layers differ: single-word page components, `any` and `{}` allowed, `_`-prefixed unused bindings, and import order left alone. It sets no formatting rule, since oxfmt formats `.vue`. Every rule the resolved config sets to warn becomes an error, so no rule warns there either. Pass `rules` to layer your own on top, and declare `@nuxt/eslint-config` in the front end's `package.json`.

## Knip

```ts
// knip.config.ts
import { antelopeKnipConfig } from "@antelopejs/tooling-configs/knip";

export default antelopeKnipConfig();
```

The defaults declare what Knip cannot infer for an AntelopeJS module:

- entry points: `src/interfaces/**/*.ts` (public API), `src/test/**` and `antelope.test.ts` (run by `ajs module test`), and `scripts/**`;
- ignored: `dist/**`, `playground/**`, `.antelope/**`, and the `@antelopejs/*` dependencies, which the runtime loads by name.

`entry`, `project`, `ignore`, `ignoreDependencies` and `ignoreBinaries` options are appended to the defaults. `frontend-vue/` stays out of `project`, so a repository can opt it in through Knip's `workspaces`.

## Interface ranges

`@antelopejs/core` keeps one copy of each `@antelopejs/interface-*` package, the one its implementing module installed, and refuses to start when a module declares a range that copy falls outside. An exact pin (`0.1.7`) or a 0.x caret (`^0.1.2` stops at `0.2.0`) therefore breaks startup at the next interface release.

`antelopejs-check-interface-ranges` fails on such a range in `dependencies` or `optionalDependencies`, in every `package.json` git tracks in the repository, from any directory:

| The package…                                      | must declare                                 |
| ------------------------------------------------- | -------------------------------------------- |
| consumes the interface                            | `>=<floor> <1.0.0` (`<next major>` from 1.0) |
| implements it (listed in `antelopeJs.implements`) | `>=<floor> <0.<minor + 1>.0` while it is 0.x |

An implementer must never be handed a breaking minor it does not implement. `workspace:`, `file:` and `link:` specs are skipped. Pass paths to check only those manifests.

```jsonc
// package.json
{
  "scripts": {
    "lint": "oxlint && antelopejs-check-interface-ranges",
  },
}
```

## Vendored anti-slop

`src/oxc/anti-slop/` is a byte-identical copy of upstream, so it can be diffed against new releases; `src/oxc/anti-slop/VENDORED.md` records the commit and any local edit. This repository does not format or lint it. Upstream is MIT (`src/oxc/anti-slop/LICENSE`).

## Documentation guardrail

The [documentation action](./docs/documentation-checks.md) checks local Markdown
links and explicitly labeled compatibility tables. Consumers can also opt in
complete TypeScript examples and reference-page export coverage. Pin
`AntelopeJS/tooling-configs/actions/docs` to a full commit SHA; no npm release is
required. The guide includes CI and local commands, annotation syntax, and the
checks that remain the author's responsibility.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). `pnpm install`, then `pnpm checks` runs the typecheck, lint, format check, Knip, tests, size and sync checks. Repositories with recorded debt also run the ratchet.

## License

[Apache-2.0](./LICENSE), except the vendored anti-slop rules (MIT).
