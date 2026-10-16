# @antelopejs/tooling-configs

<div align="center">
<a href="https://www.npmjs.com/package/@antelopejs/tooling-configs"><img alt="npm" src="https://img.shields.io/npm/v/@antelopejs/tooling-configs?style=for-the-badge&labelColor=000000&color=000000"></a>
<a href="./LICENSE"><img alt="License" src="https://img.shields.io/npm/l/@antelopejs/tooling-configs?style=for-the-badge&labelColor=000000&color=000000"></a>
<a href="https://discord.gg/sjK28QHrA7"><img src="https://img.shields.io/badge/Discord-18181B?logo=discord&style=for-the-badge&color=000000" alt="Discord"></a>
</div>

Shared lint, format and dead-code presets for AntelopeJS repositories, plus a check for the version ranges of interface dependencies.

- [oxlint](https://oxc.rs) and [oxfmt](https://oxc.rs) replace Biome: lint, format and Tailwind class sorting, `.vue` included.
- ESLint stays for the Nuxt front ends, from a shared config, until oxlint lints `.vue` files.
- [Knip](https://knip.dev) learns the entry points of an AntelopeJS module.
- Every preset is a function: options adjust it without copying it.

## What's in the box

| Export            | Import                                                                    | What it gives                                                         |
| ----------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `./oxc/lint`      | `import { antelopePreset } from "@antelopejs/tooling-configs/oxc/lint"`   | The oxlint preset                                                     |
| `./oxc/fmt`       | `import { antelopeFmtPreset } from "@antelopejs/tooling-configs/oxc/fmt"` | The oxfmt preset (house style)                                        |
| `./eslint`        | `import { antelopeNuxtConfig } from "@antelopejs/tooling-configs/eslint"` | ESLint for Nuxt layers                                                |
| `./knip`          | `import { antelopeKnipConfig } from "@antelopejs/tooling-configs/knip"`   | Knip for AntelopeJS modules                                           |
| `./oxc/anti-slop` | Loaded by the oxlint preset as a JS plugin                                | The vendored [anti-slop](https://github.com/dmmulroy/anti-slop) rules |
| bin               | `antelopejs-check-interface-ranges`                                       | Fails on interface ranges that break module startup                   |

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
| Type-aware     | `typescript/no-floating-promises` as an error, eight more type-aware rules as warnings                                                                                                                            | on      |
| Complexity     | `max-params` 5, `max-lines-per-function` 120, `max-lines` 500, `max-depth` 4, `complexity` 20                                                                                                                     | warn    |
| Anti-slop      | 7 of the 15 vendored rules; the 8 others are listed in `ANTI_SLOP_RULES_OFF_BY_DEFAULT`                                                                                                                           | warn    |
| Import sorting | `perfectionist/sort-imports`, autofixed by `oxlint --fix`                                                                                                                                                         | off     |

`correctness` is raised to error on purpose: oxlint reports it as warnings, and warnings never fail the command. Complexity and anti-slop start as warnings so a repository can work through its backlog before raising them to `"error"`.

Import sorting is off because it moves value imports across side-effect imports, and in an AntelopeJS module `import "./components"` is what registers the decorated classes. Turn it on only where import order does not matter.

### Options

```ts
antelopePreset({
  antiSlop: "error", // "warn" (default) | "error" | false
  importCycles: "warn", // "error" (default) | "warn" | false
  complexity: { maxParams: 8 }, // override thresholds or severity, or false
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

`@nuxt/eslint-config` supplies the Vue and TypeScript rules. The preset only records where AntelopeJS layers differ: single-word page components, `any` and `{}` allowed, `_`-prefixed unused bindings, and import order left alone. It sets no formatting rule, since oxfmt formats `.vue`. Pass `rules` to layer your own on top, and declare `@nuxt/eslint-config` in the front end's `package.json`.

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

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). `pnpm install`, then `pnpm checks` runs the typecheck, lint, format check and tests.

## License

[Apache-2.0](./LICENSE), except the vendored anti-slop rules (MIT).
