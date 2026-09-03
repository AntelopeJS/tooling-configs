# @antelopejs/tooling-configs

Shared tooling presets for AntelopeJS repositories: [oxlint](https://oxc.rs) (including
the vendored [anti-slop](https://github.com/dmmulroy/anti-slop) rules), [oxfmt](https://oxc.rs)
and [Knip](https://knip.dev).

Together they replace Biome outright — lint, format and import order — and Prettier in the
Nuxt layers, since oxfmt formats `.vue` and sorts Tailwind classes natively. The front end
keeps ESLint for linting, from a shared config here.

## Requirements

Node **24** (or at least 22.18). oxlint reads `oxlint.config.ts` and loads JS plugins by
executing TypeScript, which earlier runtimes cannot do.

## Install

The package is not on npm yet. Until it is, consume it straight from this repository:

```bash
pnpm add -D oxlint@1.81.0 oxfmt "github:AntelopeJS/tooling-configs"
```

`dist/` is committed for exactly as long as that install path lasts: pnpm 11 refuses to
run a git dependency's build unless every consumer allowlists it by commit hash, which
would break on every push here. CI fails if the committed build is stale. When the
package reaches npm, delete `dist/` from git, restore the `prepare` script, and change
consumers from `github:AntelopeJS/tooling-configs` to a version range — the import
specifiers never change.

Pin `oxlint` to the exact version this package depends on for `@oxlint/plugins`
(currently **1.81.0**). The JS plugin API is still alpha and the two packages must move
together. Once the package is published, this becomes a normal version range.

## oxlint

```ts
// oxlint.config.ts
import { defineConfig } from "oxlint";
import { antelopePreset } from "@antelopejs/tooling-configs/oxc/lint";

export default defineConfig({
  extends: [antelopePreset()],
  // Only read from the root config, never from a preset.
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

Type-aware rules (`typescript/no-floating-promises`) also need the tsgolint binary:

```bash
pnpm add -D oxlint-tsgolint
```

### What the preset turns on

| Group          | Contents                                                                                                    |
| -------------- | ----------------------------------------------------------------------------------------------------------- |
| oxc defaults   | the `correctness` category, plus the `eslint`, `typescript`, `node`, `oxc`, `import` and `promise` plugins  |
| imports        | `import/no-cycle`, `import/no-self-import`, `import/no-duplicates` as errors                                |
|                | (a repository with existing cycles starts with `importCycles: "warn"`)                                      |
| import sorting | `perfectionist/sort-imports`, autofixed by `oxlint --fix`                                                   |
| complexity     | `max-params` 5, `max-lines-per-function` 120, `max-lines` 500, `max-depth` 4, `complexity` 20 — as warnings |
| anti-slop      | all 15 generic rules, as warnings                                                                           |
| type-aware     | `typescript/no-floating-promises` as an error                                                               |

### Options

```ts
antelopePreset({
  antiSlop: "error", // "warn" (default) | "error" | false
  importCycles: "warn", // "error" (default) | "warn" | false
  complexity: { maxParams: 8 }, // override thresholds, or false
  importSorting: false, // leave imports alone
  typeAware: false, // no tsgolint in this repository
});
```

`antiSlop` and `complexity` default to warnings on purpose: a repository adopting them
has findings to work through, and a red pipeline on day one teaches the team to ignore
the pipeline. Raise them to `"error"` once the backlog is clear.

### Adding your own ignore patterns

oxlint does not merge `ignorePatterns` across `extends`. A root config that declares its
own **replaces** the preset's, so spread them:

```ts
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

### The house style

| Option                 | Value      |
| ---------------------- | ---------- |
| `printWidth`           | 80         |
| `tabWidth` / `useTabs` | 2 / spaces |
| `semi`                 | true       |
| `singleQuote`          | false      |
| `trailingComma`        | `"all"`    |

Every field is set explicitly, including those that already match oxfmt's defaults.
Repositories carry `.editorconfig` files that contradict each other — five declare tabs,
two declare spaces, which is why the codebases drifted apart in the first place — and
oxfmt falls back to `.editorconfig` for any field a config leaves unset. Stating all of
them is what makes the style identical everywhere. Fix the repository's `.editorconfig`
to match anyway, so editors agree with the formatter.

Import order is not part of it: `perfectionist/sort-imports` owns that on the lint side.
Enabling oxfmt's `sortImports` as well would have two tools sorting the same imports
differently, each undoing the other on every save.

Extra ignores are **added** to the shared ones rather than replacing them, so a repository
adopting oxfmt in stages can park a directory without losing the rest:

```ts
export default antelopeFmtPreset({ ignorePatterns: ["nuxt-layer/**"] });
```

In a Nuxt layer, pass the theme stylesheet to replace `prettier-plugin-tailwindcss`:

```ts
export default antelopeFmtPreset({
  tailwindStylesheet: "./assets/css/main.css",
});
```

### Replacing Biome

Per repository: delete `biome.json` and the `@biomejs/biome` dependency, point `lint`,
`lint:fix` and `format` at oxlint and oxfmt, and port anything the Biome config carried
that the preset does not (`noRestrictedImports` guards become `import/no-cycle`). Reformat
in its own commit and record it in `.git-blame-ignore-revs`, which GitHub honours, so the
pass does not bury the history.

## ESLint (Nuxt layers)

oxlint does not lint `.vue` files yet, so the front end stays on ESLint:

```js
// nuxt-layer/eslint.config.mjs
import { antelopeNuxtConfig } from "@antelopejs/tooling-configs/eslint";

export default antelopeNuxtConfig({ dirs: ["./playground"] });
```

`@nuxt/eslint` supplies the Vue and TypeScript rules; the preset only records where
AntelopeJS layers differ from it — single-word page components, `any` and `{}` as
load-bearing types in the interface layer, `_`-prefixed unused bindings, and import order
left to the formatter.

Formatting rules are deliberately absent, `vue/max-attributes-per-line` included: oxfmt
formats `.vue`, and a lint rule that also reflows markup would fight it on every save.
Declare `@nuxt/eslint-config` explicitly — nine layers use it today through
`@nuxt/eslint` without declaring it.

## Knip

```ts
// knip.config.ts
import { antelopeKnipConfig } from "@antelopejs/tooling-configs/knip";

export default antelopeKnipConfig();
```

The defaults declare what Knip cannot infer for an AntelopeJS module: `src/index.ts` and
the interface subpaths as public API, and `src/test/**/*.test.ts` as entry points, since
`ajs module test` is not a runner Knip has a plugin for. Without them, Knip reports the
whole test suite as dead code.

## Vendored anti-slop

`src/oxc/anti-slop/` is a copy of upstream, kept byte-identical so it can be diffed
against new releases. See `src/oxc/anti-slop/VENDORED.md` for the commit it came from and
any local edits. It is excluded from this repository's own formatting and linting.

Upstream is MIT (`src/oxc/anti-slop/LICENSE`); the rest of this repository is Apache-2.0.
