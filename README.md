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

| Export             | Import                                                                    | What it gives                                                                                              |
| ------------------ | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `./oxc/lint`       | `import { antelopePreset } from "@antelopejs/tooling-configs/oxc/lint"`   | The oxlint preset                                                                                          |
| `./oxc/fmt`        | `import { antelopeFmtPreset } from "@antelopejs/tooling-configs/oxc/fmt"` | The oxfmt preset (house style)                                                                             |
| `./eslint`         | `import { antelopeNuxtConfig } from "@antelopejs/tooling-configs/eslint"` | ESLint for Nuxt layers                                                                                     |
| `./knip`           | `import { antelopeKnipConfig } from "@antelopejs/tooling-configs/knip"`   | Knip for AntelopeJS modules                                                                                |
| `./oxc/anti-slop`  | Loaded by the oxlint preset as a JS plugin                                | The vendored [anti-slop](https://github.com/dmmulroy/anti-slop) rules                                      |
| `./oxc/guardrails` | Loaded by the oxlint preset as a JS plugin                                | The `antelopejs` comment and test-quality rules                                                            |
| `./verify`         | `import type { VerifyConfig } from "@antelopejs/tooling-configs/verify"`  | Types and check helpers for a shared verification skill's `verify.config.ts`                               |
| bin                | `antelopejs-sync`                                                         | Writes the guardrail pack into a repository; `--check` reports drift                                       |
| bin                | `antelopejs-checks`                                                       | Runs every check and prints only the failures                                                              |
| bin                | `antelopejs-ratchet`                                                      | Fails when recorded debt grows; `--update` lowers the record and adopts rules a pack release newly enabled |
| bin                | `antelopejs-suppressions`                                                 | Fails when suppressions exceed their budget or an added one breaks policy; `--update` lowers the budget    |
| bin                | `antelopejs-check-size`                                                   | Fails on authored files over 20,000 bytes and on blanket disable directives                                |
| bin                | `antelopejs-api-diff <base-ref>`                                          | Compares published declaration bundles against committed HEAD                                              |
| bin                | `antelopejs-comment-proof <base-ref>`                                     | Compares comment-free JavaScript emit against committed HEAD                                               |
| bin                | `antelopejs-body-check <body.md \| -> [--head <sha>] [--base <sha>]`      | Checks a PR body's proof and findings blocks against HEAD; `--findings` prints the findings block          |
| bin                | `antelopejs-check-interface-ranges`                                       | Fails on interface ranges that break module startup                                                        |
| bin                | `antelopejs-garden [--json] [--apply-pauses]`                             | The Gardener's scans of the organization through the GitHub API and npm                                    |
| bin                | `antelopejs-verify <command>`                                             | The harness of the shared `verify-interface`, `verify-module` and `verify-template` skills                 |

## antelopejs-garden

`antelopejs-garden` is the Gardener's deterministic scan. It reads the non-archived AntelopeJS repositories whose `pack` property is `full` or `template` and whose `tier` is N1 to N3, through the GitHub API and the npm registry, authenticated with the token `gh` is logged in with. It never clones.

- `--json` prints `{ generatedAt, findings, pauses, skipped }`. A finding is `{ key, repo, check, subject, severity, evidence, doneMeans }` with the key `repo|check|subject`, sorted. `skipped` lists every check whose source does not exist yet, or that could not run.
- Without `--json` it prints failures only. The exit code is non-zero only when a check could not run.
- `--apply-pauses` sets the repository variable `NEXT_AUTOMERGE` to `shadow` on repositories where it is `on`, when `checks` is red on `next`, the ratchet file is back on a Clean repository, or governance drifted. It never sets `on` and writes nothing else.

`antelopejs-sync` (full profile) writes the weekly mutation caller `.github/workflows/mutation.yml`, and both profiles keep the shared CI caller on the job id `ci`, so the check is reported as `ci / checks`. The `ci` job is read-only (`contents: read`) and passes `renovate-sync: false`; the `contents: write` and `actions: write` grants that let the Renovate sync push its commit and dispatch the caller live on a separate `renovate-sync` job calling `ci-renovate-sync.yml`, which sync adds when it is missing and never re-pins. Under the full profile it also sets the `docs-files` input of every ci-node caller to the existing `README.md` and `docs` of the root and of each workspace package that is not private, then keeps the caller's other listed paths that still exist. Renaming a caller to `ci` also rewrites `needs:` lists and `needs.<old-id>` reads in expressions, and sync (and `--check`) fails a caller in which a job needs a job that does not exist or reads `needs.<id>` of a job missing from its own `needs:`, since GitHub evaluates that read to null and a gate like `needs.checks.result == 'skipped'` then never fails.

## Shared verification skills

`antelopejs-sync` writes one shared verification skill into a repository: `verify-interface` for an interface, `verify-module` for an implementation module (inferred from `antelopeJs.implements`) and `verify-template` under `--profile template`. Pass `--verify interface|module|template` to choose, or `--verify custom` for a repository that keeps its own `.agents/skills/verify-<repo>/`. Sync writes `SKILL.md`, `package.json` and `tsconfig.json` in `.agents/skills/verify-<kind>/` with a `.claude/skills/verify-<kind>` link, and `--check` reports them as drift. The `tsconfig.json` extends the root one with ES module resolution and loads the Node types, so type-aware lint sees the real types of the repository's files there, Node APIs included. It never touches the repository's own layer beside them: `verify.config.ts`, `features/`, `seeded-breaks/` and `seeded-doors/`.

Every deterministic step of a verification is an `antelopejs-verify` command: `map`, `plan`, `new`, `doctor`, `journey`, `formal`, `doors`, `seeded`, `seeded-doors`, `clean`, `verdict` and `publish`. The synced `SKILL.md` documents each one for the agent that verifies.

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

| Group          | Rules                                                                                                                                                                                                                                                                                                                                                                                  | Default |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| oxc            | the `correctness` category, with the `eslint`, `typescript`, `node`, `oxc`, `import` and `promise` plugins; `no-unused-vars` (`_` prefix allowed), `eqeqeq` (`== null` allowed), `radix`, `prefer-regex-literals`, `typescript/ban-ts-comment` for `@ts-ignore` only                                                                                                                   | error   |
| Imports        | `import/no-cycle`, `import/no-self-import`, `import/no-duplicates`                                                                                                                                                                                                                                                                                                                     | error   |
| Type-aware     | `typescript/no-floating-promises` and thirteen more type-aware rules, including `no-unnecessary-type-parameters`, `no-unsafe-argument`, `no-unsafe-assignment`, `no-unsafe-return` and `use-unknown-in-catch-callback-variable`                                                                                                                                                        | error   |
| Complexity     | `max-params` 5, `max-lines-per-function` 120, `max-lines` 500, `max-depth` 4, `complexity` 20                                                                                                                                                                                                                                                                                          | error   |
| Anti-slop      | all 15 vendored rules; `no-runtime-typeof` with `allowInTypeGuards`, so a `typeof` (or `.constructor === String`) inside a type predicate or assertion function passes                                                                                                                                                                                                                 | error   |
| Guardrails     | `antelopejs/no-comments`, `antelopejs/no-inherited-key-lookup`, `antelopejs/no-presence-only-type-guard`, and with type-aware lint `antelopejs/require-tsconfig-include`; in test files `antelopejs/no-fs-read-in-tests`, `antelopejs/no-self-import-in-tests`, `antelopejs/no-constant-value-assertion`, `antelopejs/no-typeof-function-only-test` and `antelopejs/require-assertion` | error   |
| Import sorting | `perfectionist/sort-imports`, autofixed by `oxlint --fix`                                                                                                                                                                                                                                                                                                                              | off     |

Three anti-slop rules skip a value at its boundary. `no-runtime-typeof` also counts a `.js`/`.mjs` function documented `@returns {x is T}` as a type guard. `no-unsafe-dictionary-type` allows `Record<string, unknown>` as a `value is T` target or inside a type-guard body. `no-unknown-parameters` skips a `this` parameter, a parameter decorated `@JSONBody`, `@JsonBody` or `@Parameter`, the reason of a callback passed directly to `.catch(...)` or as `.then(_, onRejected)`, and the parameter of a `(reason: unknown) => void` type declared as `reject` or on a `new Promise` executor.

`no-runtime-typeof` does not report a `typeof` that only fills in the text of a message, such as ``throw new Error(`received ${typeof value}`)`` or ``assert(ok, `received ${typeof value}`)``: the template holds other text, and a `throw`, a bare `assert(...)` or a `log(...)` method that stands as a statement takes it. The same template compared, bound to a name, returned, or handed to any other call (`assert.equal`, `Set#add`, `emit`, a dispatcher) stays reported, because a caller can test it or use it as a key.

No rule warns. oxlint reports `correctness` as warnings by default, and warnings never fail the command, so the preset raises it to error. A repository with existing findings records them in `guardrails.ratchet.json` instead of lowering a severity (see [Guardrail pack](#guardrail-pack)).

The guardrail rules:

| Rule                                      | Fails on                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `antelopejs/no-comments`                  | `//` and `/* */` comments. Allowed: TSDoc `/** */`, `SAFETY: <reason>` (one block, or a run of `//` lines), `/*!` license headers, `@ts-expect-error <reason>`, oxlint/eslint directives that name their rules, `/// <reference />`, `#__PURE__`/`@__PURE__`, `@vite-ignore` and webpack magic comments, `prettier-ignore`/`oxfmt-ignore`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `antelopejs/no-inherited-key-lookup`      | `table[key]` (or `table[key] += ...`) with a computed key, or `key in table`, where `table` is declared in the same file as a string-keyed dictionary (`Record<string, V>`, `Record<PropertyKey, V>`, a string index signature, `Readonly`/`Partial` of one, a union with `undefined` or `null`, a local alias or `typeof` another table, `satisfies` or `as Record<string, V>`, a class field read as `this.field[key]`), or an untyped object literal read with an asserted key (`table[key as keyof typeof table]`). Inherited keys such as `constructor` answer `Object.prototype` members. Not reported: literal keys, `typeof x` keys, same-file `const` keys (`KEY`, `LABELS.name` of a literal-valued object), keys iterated from an array of string literals or from `Object.keys(table)`, `Object.entries(table)` or `for...in` of the same table (through `filter`, `sort` and similar), writes and `delete`, a read in a function that calls `Object.hasOwn(table, key)` or `hasOwnProperty`, null-prototype tables (`Object.create(null)`, `{ __proto__: null }`). Imported constants and keys iterated from another table are reported. Use a `Map` instead |
| `antelopejs/no-presence-only-type-guard`  | in a type predicate or assertion function narrowing `x`: `x in table` (also true for inherited keys; use `Object.hasOwn(table, x)` or a `Map`/`Set`); `"k" in x`, `Object.hasOwn(x, "k")`, `hasOwnProperty.call(x, "k")` or `Reflect.has(x, "k")` with no read of `x.k` (presence only; check the value; a read through a cast such as `(x as T).k` or `(<T>x).k` counts); a member of a type declared in the same file that the guard never reads. Members typed `unknown` and parameters typed as a union of object types (`pet: Cat \| Dog`, a discriminating `in`) are not reported, and a call to another local guard with `x` counts as checking that guard's members                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `antelopejs/require-tsconfig-include`     | a file type-aware lint reads that no `tsconfig.json` or `jsconfig.json` lists: not the nearest one, not a config it references, not one above. `oxlint-tsgolint` reads such a file in its inferred program, without the repository's compiler options or `types`, so Node and test-runner globals are error types: `typescript/no-unsafe-*` reports there are false, and findings that need those types go missing. List the file in a tsconfig that names its `types`: one beside it that extends the root tsconfig, or, for a file at the root, a composite tsconfig (`emitDeclarationOnly`, `outDir` under `node_modules/.cache`) that the root tsconfig references, which `tsc -p .` leaves unbuilt. The root `oxlint.config.ts`, `oxfmt.config.ts` and `knip.config.ts` that `antelopejs-sync` writes are exempt. On only with type-aware lint                                                                                                                                                                                                                                                                                                                       |
| `antelopejs/no-fs-read-in-tests`          | `readFileSync` or `readdirSync` from `fs` in a test file. Files under `fixtures/`, `helpers/` and `locales/` may read                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `antelopejs/no-self-import-in-tests`      | a test file that imports its own package name (`@antelopejs/<self>`, a subpath, `require`, dynamic `import()` or a re-export; `import type` is fine) unless that resolves to local code: the `exports` map publishes the subpath and `node_modules/<name>` is a link back to the package (a workspace self-link such as `link:.`). Otherwise the import resolves to the installed published copy and the test never runs local code. Import the module by relative path instead                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `antelopejs/require-assertion`            | a test with no assertion. Counts: calls named `expect*` or `assert*`, `sinon.assert.*`, supertest `.expect(...)`, and should-style `x.should…` or `should(x)`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `antelopejs/no-constant-value-assertion`  | `expect(X).toBe(literal)` where the root of `X` is an UPPER_SNAKE constant (`MAX_ITEMS`, `NAMES.if`, not `process.env.NODE_ENV`); also `.toEqual`, `.to.equal`, `.to.eq`, `.eql` and synonyms                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `antelopejs/no-typeof-function-only-test` | a test whose only assertions are `toBeTypeOf("function")`, `to.be.a("function")` or equivalents                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

Test files are `*.test.*`, `*.spec.*`, and files under `test/`, `tests/` and `__tests__/`, whatever the framework. The preset keeps four framework-neutral Jest-plugin rules: `no-disabled-tests`, `no-focused-tests`, `valid-describe-callback` and `valid-title`.

Import sorting is off because it moves value imports across side-effect imports, and in an AntelopeJS module `import "./components"` is what registers the decorated classes. Turn it on only where import order does not matter.

### Options

```ts fragment
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

oxlint reads `ignorePatterns` only from the root config, never from `extends`, so the synced `oxlint.config.ts` sets `ignorePatterns: ANTELOPE_IGNORE_PATTERNS`, and sync replaces the earlier template that did not. `ANTELOPE_IGNORE_PATTERNS` holds generated output and what sync writes under the agent directories: the synced files of each shared skill and its `.claude/skills` link, which shows the repository's own files a second time. The repository's own files under `.agents/` and `.claude/` are linted. Spread the shared patterns when adding your own:

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

| File                                                    | What `sync` does                                                                                                                                                                                                                             |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `oxlint.config.ts`, `oxfmt.config.ts`, `knip.config.ts` | Writes a config that extends the preset, unless the file already imports it                                                                                                                                                                  |
| `lefthook.yml`                                          | Pre-commit on staged files: oxfmt, oxlint, size, suppressions. Pre-push: typecheck                                                                                                                                                           |
| `package.json`                                          | `prepare` installs lefthook. Sets `checks`, `size`, `ratchet`, `ratchet:update`, `suppressions`, `suppressions:update`, `sync`, `sync:check`; adds missing `typecheck`, `lint`, `format`, `format:check`, `knip`; adds `lefthook` and `knip` |
| `.nvmrc`                                                | `24`                                                                                                                                                                                                                                         |
| `.agents/setup`                                         | Orb setup: switches to the `.nvmrc` Node, activates `packageManager` through corepack, installs with the frozen lockfile                                                                                                                     |
| `AGENTS.md`                                             | Writes the managed block between `<!-- antelopejs-guardrails:start -->` and `:end -->`; text outside the markers stays                                                                                                                       |
| `README.md` of each `@antelopejs` package               | Writes the generated compatibility block (see [Generated compatibility block](./docs/documentation-checks.md#generated-compatibility-block)); prose outside its markers stays                                                                |
| `CLAUDE.md`                                             | `@AGENTS.md`                                                                                                                                                                                                                                 |
| `guardrails.ratchet.json`                               | Records non-empty debt on first adoption, before `sync:check` exists                                                                                                                                                                         |
| `guardrails.suppressions.json`                          | Records the current suppression counts when the file is missing; restores the committed file instead when HEAD has one; otherwise only adds `config` and `agentFiles` at today's counts when the file predates them                          |
| `<layer>/build/backend-boundary.ts`                     | Where a DMS frontend layer tracks one, restores the pack's backend boundary plugin for the package that holds the layer. A formatter's rewrite is not drift; any other edit is                                                               |

`--profile template` writes only the three preset configs, a user-facing `AGENTS.md` block and the `suppressions` package scripts (plus `ratchet` once `guardrails.ratchet.json` exists) that `antelopejs-checks` requires, for template repositories. `antelopejs-sync --check` writes nothing and exits 1 on any drift; `pnpm run checks` runs it.

`pnpm run checks` runs `typecheck`, `lint`, `format:check`, `knip`, `test`, `size`, `suppressions` and `sync:check`, plus `ratchet` when `guardrails.ratchet.json` exists. It prints only the output of the steps that failed. Sync adds the ratchet scripts and pre-commit hook only while that file exists.

### Ratchet

`guardrails.ratchet.json` holds the debt a repository had when it adopted the pack:

```json
{
  "pack": "0.2.17",
  "rules": { "antelopejs/no-comments": 22, "eslint/max-depth": 1 },
  "oversizeFiles": { "src/legacy.ts": 31250 }
}
```

- A rule listed under `rules` is off for `oxlint`, so editors, hooks and `lint` stay green. `antelopejs-ratchet` counts it with every rule on, and fails when a count rises. It prints the findings in the files the change touched.
- A file listed under `oversizeFiles` may exceed 20,000 bytes and `max-lines`, up to its recorded size. Any other file over either limit fails. When git sees a listed file renamed (`git mv`, or a staged delete and add), the allowance moves to the new path and never exceeds the old one; a copy or a new file inherits nothing. `antelopejs-ratchet --base <ref>` detects renames against that revision instead of `HEAD`, for a rename that was committed before the file was updated.
- The pre-commit hook runs `antelopejs-ratchet --staged`: for each rule under `rules` it counts the findings in the staged files and in those files at HEAD and at the merge-base of HEAD with the pull request base (`origin/$GITHUB_BASE_REF`, else `origin/HEAD`), rename sources and deleted files included, linted under the staged configuration. A merge-base finding counts only for a staged finding of the same rule on the same line, unchanged since the merge-base, and only while the files the branch changed hold no more findings of that rule than at the merge-base. It fails a rule whose staged count is above both, and lists the findings on lines that differ from HEAD and from the merge-base. Code moved between staged files, a legacy line that is reformatted or edited, a line restored byte for byte to its base form, a `SAFETY:` comment the branch added and the commit removes, or an edit of a file a legacy finding moved into earlier on the branch, nets out; a new finding does not, even next to a moved block. Locally the base is always `origin/HEAD`, so a branch stacked on another branch is compared with HEAD and the default branch, not with its parent branch. Without `origin/HEAD` (`git remote set-head origin --auto` sets it) or a merge-base, it compares with HEAD only and says so when it fails.
- `antelopejs-ratchet --update` lowers each number to the current count and removes what reached zero. It never raises a number. The only entries it adds are rules a pack release enabled after the release recorded under `pack`: `PACK_NEW_RULES` in `src/guardrails/adoption.ts` lists each such rule with the release that enabled it. After a pack upgrade, the update records today's count of each one that has findings, then moves `pack` forward, so a rule fixed to zero and later broken again is never adopted twice. Without `pack`, the repository's adopted release is the pack its lockfile installs at the pull request base (pnpm or npm), and an unknown one predates every listed rule. A clean repository with findings for such a rule gets a ratchet file holding only those rules; run `antelopejs-sync` afterwards for the ratchet scripts and hook. Commit the file. The same update records the size of each oversize file under the agent directories (`.agents/`, `.claude/`, `.amp/` and the others) that has no allowance, once, in a repository whose adopted release predates 0.2.18, the release that began counting the repository's own files there; `antelopejs-ratchet --base` accepts those allowances for files that exist at the base, at no more than their size there, and no other.
- Against the pull request base (`GITHUB_BASE_REF` in CI, else `origin/HEAD`, or `--base <ref>`), `antelopejs-ratchet` fails an entry added or raised by hand: a rule the pack did not newly enable, a pack-new rule above its count or above its count in the base tree, an oversize allowance for a file that is not a rename of one, and a lowered or dropped `pack`. A first adoption (no ratchet file and no suppression budget at the base) passes.

When every rule count is zero and `oversizeFiles` is empty, the ratchet is retired. `antelopejs-ratchet --update` deletes the file and asks you to run `antelopejs-sync`. Sync then removes `ratchet`, `ratchet:update`, the ratchet hook and the Debt instructions. Commit those changes together. An empty baseline on first adoption creates no file. Later syncs never recreate it because the `sync:check` script marks adoption.

`antelopejs-sync --check` rejects an existing retired file and tells you to run `ratchet:update`. Plain sync reports the same note but leaves deletion to the update command.

### Suppression budget

`guardrails.suppressions.json` caps the suppressions in authored code files. It is separate from the ratchet and permanent: it stays when its counts reach zero and when the ratchet is retired.

```json
{
  "rules": { "anti-slop/no-chained-type-assertions": 19, "*": 0 },
  "tsExpectError": 8,
  "tsIgnore": 0,
  "safety": 2,
  "config": { "typescript/unbound-method for src/test/**": 1 }
}
```

- `rules` holds lint directives (`oxlint-disable`, `eslint-disable`, their `-line` and `-next-line` forms, in line or block comments, after code too) per rule they name; a directive naming several rules counts once per rule, and one naming none counts under `*`. A rule missing from `rules` has ceiling 0. The other fields count `@ts-expect-error`, `@ts-ignore` and `SAFETY:` comments. The counter is the one behind the proof tables: it reads comments from the parser, so strings and template literals are never counted, and it skips generated output as the size guard does.
- `config` holds the rules a lint config switches off, to `allow` or to a warning, keyed `<rule> for <glob>`: in `oxlint.config.*`, `.oxlintrc.json`, `.oxlintrc.jsonc` and `eslint.config.*` at any depth, every `rules` and `categories` map (a category as `category:<name>`) and an ESLint composer's `overrideRules` argument, one key per glob of the block's `files` (`*` when it has none). A nested config's globs are anchored at its directory and its blocks without `files` are `<dir>/**`, so a rule-off moved between config files is a new key. Rule maps, severities and globs held in same-file variables or spread from them count where they are used; the pack's presets are not in the file, so they never count. A glob is a key of its own, so adding, widening or renaming a glob, deleting `files`, or moving an override's rules to the top level creates a key at ceiling 0 and fails. Narrowing or splitting a scope is burn-down: a key may use the room a same-rule key whose glob contains its glob gives up (`*`, `**` and `**/*` contain every glob; a single-segment `*` never contains `**`; other glob syntax counts only when equal), in the full, staged and base checks, and `--update` moves that ceiling to the narrower key. A scope split into several narrower globs gives each the old ceiling, so the `config` total can rise while the files it covers do not; read totals per key, not as a measure of scope. `.` and `..` segments count only when equal. A failure names the fix: delete the entry and fix the code its rule reports, or put the exception on the line that needs it as a directive with a reason. A config entry switching off a rule no directive may name fails as an added directive does. Sync adds `config` at today's counts to a budget that predates it; until then config rule-offs are not capped.
- `agentFiles` is `true` once the budget counts the repository's own files under the agent directories (`.agents/`, `.claude/`, `.amp/` and the others), skipping only what `antelopejs-sync` writes there, which is what lint skips. A budget without it counts none of them, so upgrading fails nothing: `antelopejs-sync` adds each key's count in those files to its ceiling and sets the field. `antelopejs-suppressions --base` allows that one rise on a base without the field, by no more than the count in those files at the base per key (a directive the same branch adds there is not adoptable), and fails a budget that drops the field once the base has it.
- `antelopejs-suppressions` fails when a count is above its ceiling, printing each `file:line` in the files the change touched and the fix: fix the code, or remove another suppression of the same kind; a rule that keeps needing suppressions should be changed in the preset. It prints nothing on success.
- `antelopejs-suppressions --update` lowers each ceiling to the current count and keeps rules at zero. No command raises a ceiling.
- `SAFETY:` comments and directives disabling `anti-slop/require-safety-comment-for-type-assertion` share their room: a `SAFETY:` comment may use what those directives leave below their ceiling, in the full, base and staged checks, and `--update` moves that room to `safety`. Replacing such a directive with a `SAFETY:` comment needs no raise; their sum never rises.
- `antelopejs-suppressions` also compares the budget with the one on the pull request base: `--base <ref>` when given, else the `GITHUB_BASE_REF` branch in CI (fetched from `origin` into a shallow checkout), else `origin/HEAD`. It fails when a ceiling is higher than on the base or a rule the base lists is removed, so a raise merges only through the operator's ruleset bypass. A base without a budget, a first adoption, passes. Without a base the comparison is skipped.
- The pre-commit hook runs `antelopejs-suppressions --staged`: it compares the suppressions in the staged files with those files at HEAD, following renames and counting deleted files, and fails a kind that rises by more than the staged budget raises its ceiling. A suppression moved between staged files nets out.
- `@ts-ignore` is also a lint error (`typescript/ban-ts-comment`); `@ts-expect-error` fails once its error is gone.
- Both modes also judge what the change adds, whatever the budget allows: the full check against the same base (HEAD when there is none), the staged check against HEAD. A suppression counts as added when its kind, rule and reason occur more often than on the base, so one moved to another file with its reason is not added, and one whose reason a comment pass rewrote or stripped is. An added directive fails when it names a rule no directive may name (`anti-slop/require-safety-comment-for-type-assertion`, `antelopejs/no-comments`, the five `antelopejs` test rules, `typescript/ban-ts-comment`); the failure names what to do instead. An added directive naming its rules, `@ts-expect-error` or `SAFETY:` comment fails when its reason has fewer than three words, or only words like "safe", "intentional", "legacy" and the rule's own name. A block `oxlint-disable` or `eslint-disable` that no `-enable` closes before the end of its file fails when the change adds it. Suppressions already on the base stay under the budget until a burn-down removes them.
- Both modes also hold each lint directive in a file the change touches to two rules, whether the directive was added or already on the base. It must suppress something: one extra `oxlint --report-unused-disable-directives` run over the touched files that contain a directive, under the repository's own lint configuration with every ratchet rule enabled, so a directive for a rule the ratchet turns off is live while the rule still reports there, and a directive for a rule the preset does not run is dead. A dead directive fails with its `file:line`, naming the rule to drop when the directive names several, or telling you to delete it. It must also give a reason: a directive naming rules with no ` -- <reason>` fails whenever its file is touched, though the added-suppression policy above only judges the reason of an added one. Touched files are the staged files in the pre-commit hook, and in the full check the working tree against the merge-base with the pull request base (the base itself when there is no merge-base, as in a shallow checkout), untracked files included, or against HEAD without a base. A file the change does not touch is not read, so upgrading the pack fails no existing file; its dead and reasonless directives surface when a change next touches the file. `eslint-` directives in a directory with an ESLint config are left to ESLint, and `.vue` files are not read by oxlint. Deleting a dead directive lowers the budget: run `suppressions:update`.

### Size

`antelopejs-check-size` fails on an authored file over 20,000 bytes, tests included. The repository's own files under the agent directories count; the files `antelopejs-sync` writes there (the `SYNCED_AGENT_PATTERNS` that lint skips) do not. Generated code (`dist`, `coverage`, `.nuxt`, `.output`, and `build` or `output` at the repository root or a package root, never under `src/` or `test/`), fixtures, lockfiles, `CHANGELOG.md`, Markdown and binary assets are excluded. JSON is data, never code: every `*.json`, `*.jsonc` and `*.json5` file is excluded, wherever it lives. Lint and format still cover it. Files over the limit with a NUL byte in their first 8,000 bytes are binary even without a known extension. Staged checks inspect the index blob. Excluded files are also removed from recorded size allowances on ratchet update.

Pass paths to check only those files, as the pre-commit hook does. The command also fails on an `oxlint-disable` or `eslint-disable` directive (line, next-line or file form) that names no rule: oxlint applies such a directive before any rule runs, so `no-comments` cannot report it. It reads real comments only, with the same counter as the proof tables, so directive text inside a string is not reported.

### Cleanup proof

A behaviour-preserving cleanup PR shows `antelopejs-api-diff <base-ref>` passing. It checks each tracked package with a `tsconfig.json` that publishes something (not private, and declaring `exports`, `main`, `types`, `typings` or `typesVersions`) and lists the others as `API: skipped <directory>, <reason>.`. Each package is analysed and bundled with its own installed TypeScript, falling back to the one `dts-bundle-generator` brings only when neither the package nor its workspace root declares `typescript` (the proof then prints `<directory>: declares no typescript; using the pack's TypeScript <version>`). A package that declares `typescript` but cannot resolve it fails with an execution error naming the package and asking for an install, because its declaration half would otherwise pass on a broken install; a TypeScript without the programmatic compiler API (7 and later) is reported as an execution error naming the package, and the other packages are still analysed. Large packages are bundled by several worker processes (up to 8, bounded by cpus and free memory); the output is the same as a single process. It emits declarations without comments, resolves published entries from `exports` (preferring `types`), `main`, `types`/`typings` and `typesVersions`, and bundles each entry's local declaration closure. External packages stay external. Stable top-level ordering ignores declaration moves between internal files while preserving overload order. Members of object type literals, interfaces and classes are compared in a canonical order, because TypeScript can emit an inferred object type's properties in another order after a refactor; overloads, call and construct signatures, tuple elements, parameters, enum members and union constituents keep their written order. Compiler errors fail the proof.

A comment-only PR shows `antelopejs-comment-proof <base-ref>` passing instead of a verifier. It includes private packages, ignores type diagnostics and compares comment-free JavaScript emit byte for byte. Both commands exclude test sources, fail on added or removed outputs, and print unified diffs for changes.

Test-helper entries are outside both halves. A published entry whose built file is test output relative to `outDir` (under `test/`, `tests/` or `__tests__/`, or named `*.test.*` or `*.spec.*`) is neither bundled nor loaded, because helpers such as `./tests/*` import a test runner that the proof does not run. This applies the same way to the declaration and the runtime half, to wildcard and plain targets, and to files a general wildcard such as `./*` matches. Each half prints `API: skipped test-helper entry <target> in <directory>` or `Runtime API: skipped test-helper entry <target> in <directory>`; a package whose only wildcard export is `./tests/*` still has its other entries compared in both halves.

Pass `--allow-added <glob>` (repeatable) to `antelopejs-api-diff` when a refactor adds helper files that a wildcard export publishes, such as an `internal/` directory under `"./*"`. An added entry passes, in both the declaration and the runtime half, when its published subpath matches a glob (for example `--allow-added '**/internal/**'`, matched against `base/table-view/internal/helper` for `./base/table-view/internal/helper`) and its source module is marked `@internal`: a leading `/** @internal @packageDocumentation */` comment on the module (`@module` and `@fileoverview` also qualify), or an `@internal` tag on every exported declaration. Allowed entries are printed under `Added (allowed): <count>`; nothing is printed when no entry was added. An added entry that matches but is not marked `@internal` fails with the file and the fix. Added entries matching no glob, removed entries and changed entries still fail, matching or not. Without the flag nothing changes.

```bash
pnpm exec antelopejs-api-diff origin/main --allow-added '**/internal/**'
```

A DMS frontend module publishes more than its package entries: every export of a file under a directory its `dms.frontend.build.ts` passes to `registerAutoImports` is auto-imported into every frontend module, `@internal` or not, and the package itself is usually private. For each tracked `dms.frontend.build.ts`, the proof reads the declared directories (string literals only; anything else is an execution error naming the form to write), drops `app/build/` and directories outside the module as `@antelopejs/dms-frontend` does, and lists one `<name> (value|type): <signature>` line per auto-imported name under `Auto-imports:`. Names are read statically with the module's TypeScript, which resolves `export *` and the `#<layer>/*` aliases; no Vite build runs. Each scanned module is typed with the imports unimport would inject for the names it uses without importing them: dms-frontend's `templates/vue/frontend-module.ts` exports, `vue`'s exports and the module's own auto-imports. A composable returning `ref<T>()` or `useDmsState<T>()` therefore prints `T`, not `any`. Types re-exported from a `.vue` file, `@nuxt/ui` auto-imports and another module's auto-imports are not modelled and print as `any` on both sides. Values print their type, types their structure, both in the canonical member and union order of the declaration half, so moving an export between scanned files or changing an unexported helper passes. A removed, added or changed line fails, and `--allow-added` never applies to it: move a helper that must stay private under `app/build/`. Repositories without a `dms.frontend.build.ts` print no `Auto-imports:` line.

Both commands end with a table of suppressions in authored code files at the base and at HEAD, for PR bodies to copy: lint directives per rule they name (`*` for a directive naming none), `@ts-expect-error`, `@ts-ignore` and `SAFETY:` comments. The parser finds every comment, after code on the same line too, and skips strings, template literals and JSX text; `.vue` files contribute their script blocks and template comments. Generated output and the agent files `antelopejs-sync` writes are left out as the size guard leaves them out.

Both commands compare **committed HEAD**, not staged or working-tree edits. They check out the base and HEAD in temporary detached worktrees, reuse the current checkout's root and package `node_modules`, and remove the worktrees afterwards. Install the consumer's dependencies before running them.

```bash
pnpm exec antelopejs-api-diff origin/main
pnpm exec antelopejs-comment-proof origin/main
```

### PR body check

Both proof commands end their output with a `<!-- antelopejs-proof ... -->` line that stamps the base, the committed head, the command, the number of lines printed and a digest of them. Paste the whole output down to that line, which renders invisibly; indenting it, wrapping it in a code fence or re-padding the tables keeps it valid. The check reads the stamped number of non-blank lines above the stamp as the copy.

`antelopejs-body-check --findings` prints every lint finding of the working tree as a block between `<!-- antelopejs-findings begin -->` and `<!-- antelopejs-findings end -->`, one ``- `path:line` `rule`: <why>`` line per finding under a `` `rule` (count): `` line. Paste it under the findings-left heading, replace each `<why>` with the reason the finding stays, and delete the rules the pull request does not report on. Lines may be regrouped under prose bullets.

`antelopejs-body-check <body.md>` (`-` reads standard input) checks the body against the repository at HEAD and prints one line per problem:

- a proof block whose lines no longer match its digest, whose head is not in the branch, or, for api-diff, whose head tree is not HEAD's; a suppression table that no longer matches the counts at HEAD against the stamped base. A comment-proof block may be stamped at an earlier commit of the branch, so a comment-only commit can be proven under a later code commit;
- a suppression table or a proof summary line (`API:`, `Runtime API:`, `Comment proof:`) outside a stamped block;
- in a findings block: a line that is not a live diagnostic of that rule at that line, a listed rule with a live finding the block leaves out, a finding with no reason, a `path:line` written outside the item form, and a count such as ``(9 `no-unknown-parameters`)`` that differs from the items of that rule under it;
- a code file named (`path.ts`, with or without `:line`, or a range) in a findings-left section outside a findings block. A section opens at a heading, or at a plain or bold title line, that says what is left, kept or remaining under the ratchet or in findings (`## Findings left under the ratchet`, `Findings left under the ratchet:`, `**Left under the ratchet**`, `## Kept under the ratchet`, `## Not fixed`), and ends at the next heading of its level or above (the next heading of any level for a plain or bold line);
- with `--base <sha>`, an api-diff block compared against a revision whose merge-base with HEAD is not the pull request base's.

Counts in prose are not checked. Run it on a checkout of the pull request head, with history back to the stamped base:

```bash
gh pr view <number> --json body --jq .body | pnpm exec antelopejs-body-check -
```

In CI, run it in a `pull_request` job (types `opened`, `edited`, `synchronize`) that checks out `github.event.pull_request.head.sha` with `fetch-depth: 0`, installs dependencies, and passes the body through the environment rather than inline in the script: `printf '%s' "$PR_BODY" | pnpm exec antelopejs-body-check - --head "$HEAD_SHA"`. `--head` fails when the checkout is not that commit. Add `--base "$BASE_SHA"` (`github.event.pull_request.base.sha`) so an api-diff block cannot be taken against HEAD itself.

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

```ts fragment
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
links, explicitly labeled compatibility tables, and reference-page export
coverage, and typechecks every TypeScript fence against the repository's own
source; a fence opts out only with a `fragment` marker. Versions of
`@antelopejs/*` packages belong only in the block `antelopejs-sync` generates:
the action fails on version ranges and "requires … or later" claims in prose and
checks the block against the package.json beside it. Pin
`AntelopeJS/tooling-configs/actions/docs` to a full commit SHA; no npm release is
required. The guide includes CI and local commands, marker syntax, and the
checks that remain the author's responsibility.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). `pnpm install`, then `pnpm checks` runs the typecheck, lint, format check, Knip, tests, size and sync checks. Repositories with recorded debt also run the ratchet.

## License

[Apache-2.0](./LICENSE), except the vendored anti-slop rules (MIT).
