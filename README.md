# @antelopejs/tooling-configs

Shared tooling presets for AntelopeJS repositories: an [oxlint](https://oxc.rs) preset
(including the vendored [anti-slop](https://github.com/dmmulroy/anti-slop) rules) and a
[Knip](https://knip.dev) preset for dead code.

Formatting is deliberately **not** covered yet: repositories keep Biome for that.

## Requirements

Node **24** (or at least 22.18). oxlint reads `oxlint.config.ts` and loads JS plugins by
executing TypeScript, which earlier runtimes cannot do.

## Install

The package is not on npm yet. Until it is, consume it straight from this repository —
pnpm clones it and runs its `prepare` build:

```bash
pnpm add -D oxlint@1.81.0 "github:AntelopeJS/tooling-configs"
```

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
    "lint:fix": "oxlint --fix"
  }
}
```

Type-aware rules (`typescript/no-floating-promises`) also need the tsgolint binary:

```bash
pnpm add -D oxlint-tsgolint
```

### What the preset turns on

| Group | Contents |
| --- | --- |
| oxc defaults | the `correctness` category, plus the `eslint`, `typescript`, `node`, `oxc`, `import` and `promise` plugins |
| imports | `import/no-cycle`, `import/no-self-import`, `import/no-duplicates` as errors |
| import sorting | `perfectionist/sort-imports`, autofixed by `oxlint --fix` |
| complexity | `max-params` 5, `max-lines-per-function` 120, `max-lines` 500, `max-depth` 4, `complexity` 20 — as warnings |
| anti-slop | all 15 generic rules, as warnings |
| type-aware | `typescript/no-floating-promises` as an error |

### Options

```ts
antelopePreset({
  antiSlop: "error",              // "warn" (default) | "error" | false
  complexity: { maxParams: 8 },   // override thresholds, or false
  importSorting: false,           // leave imports alone
  typeAware: false,               // no tsgolint in this repository
});
```

`antiSlop` and `complexity` default to warnings on purpose: a repository adopting them
has findings to work through, and a red pipeline on day one teaches the team to ignore
the pipeline. Raise them to `"error"` once the backlog is clear.

### Adopting it next to Biome

While a repository still formats with Biome:

- turn off Biome's import assist (`assist.actions.source.organizeImports`), otherwise it
  and `perfectionist/sort-imports` will each undo the other's work on every save;
- turn off Biome's linter (`linter.enabled: false`) and keep only `biome format`, so a
  rule never gets enforced twice with two different opinions.

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
