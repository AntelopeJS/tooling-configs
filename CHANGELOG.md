# Changelog

## v0.2.13

[compare changes](https://github.com/AntelopeJS/tooling-configs/compare/v0.2.12...v0.2.13)

### 🩹 Fixes

- **verify:** Fail formal findings only on changed behaviour, resolve Node built-ins in declarations ([#53](https://github.com/AntelopeJS/tooling-configs/pull/53))

### ❤️ Contributors

- Antony Rizzitelli ([@Upd4ting](http://github.com/Upd4ting))

## v0.2.12

[compare changes](https://github.com/AntelopeJS/tooling-configs/compare/v0.2.11...v0.2.12)

### 🚀 Enhancements

- **verify:** Add the shared verify-interface, verify-module and verify-template skills ([#51](https://github.com/AntelopeJS/tooling-configs/pull/51))

### 🩹 Fixes

- **suppressions:** Name the missing base ref when fetching it fails ([#46](https://github.com/AntelopeJS/tooling-configs/pull/46))

### ❤️ Contributors

- Antony Rizzitelli ([@Upd4ting](http://github.com/Upd4ting))

## v0.2.11

[compare changes](https://github.com/AntelopeJS/tooling-configs/compare/v0.2.10...v0.2.11)

### 🚀 Enhancements

- **lint:** Flag tests that import their own package name instead of local source ([#43](https://github.com/AntelopeJS/tooling-configs/pull/43))

### 🩹 Fixes

- **api-diff:** Skip ./tests/* test-helper entries in both halves and say so ([#42](https://github.com/AntelopeJS/tooling-configs/pull/42))
- **ratchet:** Compare staged findings by net per-rule count so moves and reformats pass ([#40](https://github.com/AntelopeJS/tooling-configs/pull/40))

### ❤️ Contributors

- Antony Rizzitelli ([@Upd4ting](http://github.com/Upd4ting))

## v0.2.10

[compare changes](https://github.com/AntelopeJS/tooling-configs/compare/v0.2.9...v0.2.10)

### 🚀 Enhancements

- **lint:** Accept typeof inside type guards and assertion functions ([#39](https://github.com/AntelopeJS/tooling-configs/pull/39))

### ❤️ Contributors

- Antony Rizzitelli <rizzitelli.antony@pm.me>

## v0.2.9

[compare changes](https://github.com/AntelopeJS/tooling-configs/compare/v0.2.8...v0.2.9)

### 🚀 Enhancements

- **garden:** Add the antelopejs-garden bin and sync the CI and mutation callers ([#38](https://github.com/AntelopeJS/tooling-configs/pull/38))

### ❤️ Contributors

- Antony Rizzitelli ([@Upd4ting](http://github.com/Upd4ting))

## v0.2.8

[compare changes](https://github.com/AntelopeJS/tooling-configs/compare/v0.2.7...v0.2.8)

### 🚀 Enhancements

- **guardrails:** Reject suppressing instead of fixing in added code ([#36](https://github.com/AntelopeJS/tooling-configs/pull/36))

### 🩹 Fixes

- **guardrails:** Fail api-diff when a declared typescript cannot resolve ([#37](https://github.com/AntelopeJS/tooling-configs/pull/37))

### ❤️ Contributors

- Antony Rizzitelli ([@Upd4ting](http://github.com/Upd4ting))

## v0.2.7

[compare changes](https://github.com/AntelopeJS/tooling-configs/compare/v0.2.6...v0.2.7)

### 🚀 Enhancements

- **guardrails:** Cap suppressions with a per-repository budget ([#35](https://github.com/AntelopeJS/tooling-configs/pull/35))

### 🩹 Fixes

- **guardrails:** Count every suppression comment with one parser-based counter ([#34](https://github.com/AntelopeJS/tooling-configs/pull/34))

### ❤️ Contributors

- Antony Rizzitelli <rizzitelli.antony@pm.me>

## v0.2.6

[compare changes](https://github.com/AntelopeJS/tooling-configs/compare/v0.2.5...v0.2.6)

### 🩹 Fixes

- **guardrails:** Exclude every JSON file from the size guard ([#33](https://github.com/AntelopeJS/tooling-configs/pull/33))

### ❤️ Contributors

- Antony Rizzitelli <rizzitelli.antony@pm.me>

## v0.2.5

[compare changes](https://github.com/AntelopeJS/tooling-configs/compare/v0.2.4...v0.2.5)

### 🩹 Fixes

- **guardrails:** Compare api-diff declarations independent of object member order ([#30](https://github.com/AntelopeJS/tooling-configs/pull/30))

### ❤️ Contributors

- Antony Rizzitelli ([@Upd4ting](http://github.com/Upd4ting))

## v0.2.4

[compare changes](https://github.com/AntelopeJS/tooling-configs/compare/v0.2.3...v0.2.4)

### 🚀 Enhancements

- **guardrails:** Let api-diff pass added @internal entries with --allow-added ([#26](https://github.com/AntelopeJS/tooling-configs/pull/26))

### ❤️ Contributors

- Antony Rizzitelli ([@Upd4ting](http://github.com/Upd4ting))

## v0.2.3

[compare changes](https://github.com/AntelopeJS/tooling-configs/compare/v0.2.2...v0.2.3)

### 🚀 Enhancements

- **guardrails:** Fail entry-only exemptions and runtime export changes in cleanup proofs ([#23](https://github.com/AntelopeJS/tooling-configs/pull/23))

### 🩹 Fixes

- **guardrails:** Pass the staged ratchet when oxlint ignores every staged file ([#22](https://github.com/AntelopeJS/tooling-configs/pull/22))
- **guardrails:** Scope generated-output globs and carry oversize allowances across renames ([#24](https://github.com/AntelopeJS/tooling-configs/pull/24))

### ❤️ Contributors

- Antony Rizzitelli <rizzitelli.antony@pm.me>
- Maxime Westhoven ([@mwesto](http://github.com/mwesto))

## v0.2.2

[compare changes](https://github.com/AntelopeJS/tooling-configs/compare/v0.2.1...v0.2.2)

### 🚀 Enhancements

- **guardrails:** Add cleanup proofs and retire the ratchet at zero debt ([#19](https://github.com/AntelopeJS/tooling-configs/pull/19))

### 🏡 Chore

- Configure Renovate with the shared preset ([#18](https://github.com/AntelopeJS/tooling-configs/pull/18))

### ❤️ Contributors

- Antony Rizzitelli ([@Upd4ting](http://github.com/Upd4ting))

## v0.2.1

[compare changes](https://github.com/AntelopeJS/tooling-configs/compare/v0.2.0...v0.2.1)

### 🩹 Fixes

- **guardrails:** Exclude assets and fixtures under dot directories from the size guard ([#17](https://github.com/AntelopeJS/tooling-configs/pull/17))

### ❤️ Contributors

- Antony Rizzitelli ([@Upd4ting](http://github.com/Upd4ting))

## v0.2.0

[compare changes](https://github.com/AntelopeJS/tooling-configs/compare/v0.0.9...v0.2.0)

### 🚀 Enhancements

- ⚠️  Turn tooling-configs into the guardrail pack ([#16](https://github.com/AntelopeJS/tooling-configs/pull/16))

#### ⚠️ Breaking Changes

- ⚠️  Turn tooling-configs into the guardrail pack ([#16](https://github.com/AntelopeJS/tooling-configs/pull/16))

### ❤️ Contributors

- Antony Rizzitelli <rizzitelli.antony@pm.me>

## v0.0.9

[compare changes](https://github.com/AntelopeJS/tooling-configs/compare/v0.0.8...v0.0.9)

### 🚀 Enhancements

- **docs:** Add a commit-pinned shared documentation guardrail ([#15](https://github.com/AntelopeJS/tooling-configs/pull/15))

### 📖 Documentation

- Rewrite the README ([#14](https://github.com/AntelopeJS/tooling-configs/pull/14))

### ❤️ Contributors

- Antony Rizzitelli <rizzitelli.antony@pm.me>

## v0.0.8

[compare changes](https://github.com/AntelopeJS/tooling-configs/compare/v0.0.7...v0.0.8)

### 🩹 Fixes

- **fmt:** Ignore CHANGELOG.md in the oxfmt preset ([#13](https://github.com/AntelopeJS/tooling-configs/pull/13))

### ❤️ Contributors

- Antony Rizzitelli <rizzitelli.antony@pm.me>

## v0.0.7

[compare changes](https://github.com/AntelopeJS/tooling-configs/compare/v0.0.6...v0.0.7)

### 🚀 Enhancements

- Add antelopejs-check-interface-ranges ([#12](https://github.com/AntelopeJS/tooling-configs/pull/12))

### 🏡 Chore

- Align community files with the organization defaults ([#9](https://github.com/AntelopeJS/tooling-configs/pull/9))

### 🤖 CI

- **release:** Release next from a dedicated branch and restore requireCommits ([#10](https://github.com/AntelopeJS/tooling-configs/pull/10))
- **release:** Reference the shared release workflows through v1 ([#11](https://github.com/AntelopeJS/tooling-configs/pull/11))

### ❤️ Contributors

- Antony Rizzitelli <rizzitelli.antony@pm.me>

## v0.0.6

[compare changes](https://github.com/AntelopeJS/tooling-configs/compare/v0.0.5...v0.0.6)

### 🩹 Fixes

- Retire the Nuxt-layer ignores and cover the whole test harness ([#8](https://github.com/AntelopeJS/tooling-configs/pull/8))

### 📖 Documentation

- Complete open source project metadata ([#7](https://github.com/AntelopeJS/tooling-configs/pull/7))

### 🤖 CI

- Use shared npm release workflow ([#6](https://github.com/AntelopeJS/tooling-configs/pull/6))

### ❤️ Contributors

- Antony Rizzitelli <rizzitelli.antony@pm.me>

## v0.0.5

[compare changes](https://github.com/AntelopeJS/tooling-configs/compare/v0.0.4...v0.0.5)

### 🚀 Enhancements

- Leave import sorting off by default ([#4](https://github.com/AntelopeJS/tooling-configs/pull/4))

### 🩹 Fixes

- Leave GitHub's legacy issue templates alone ([#5](https://github.com/AntelopeJS/tooling-configs/pull/5))

### ❤️ Contributors

- Thomas ([@Thomasims](http://github.com/Thomasims))
- Fabrice Cst <fabrice@altab.be>

## v0.0.4

[compare changes](https://github.com/AntelopeJS/tooling-configs/compare/v0.0.3...v0.0.4)

### 🚀 Enhancements

- Leave seven anti-slop rules off by default ([#3](https://github.com/AntelopeJS/tooling-configs/pull/3))

### ❤️ Contributors

- Fabrice Cst <fabrice@altab.be>

## v0.0.3

[compare changes](https://github.com/AntelopeJS/tooling-configs/compare/v0.0.2...v0.0.3)

### 🚀 Enhancements

- Ignore the ajs binary by default ([a5ef9e2](https://github.com/AntelopeJS/tooling-configs/commit/a5ef9e2))
- Stage no-base-to-string too ([4f31de3](https://github.com/AntelopeJS/tooling-configs/commit/4f31de3))
- Ignore the antelopejs scope by default ([52646de](https://github.com/AntelopeJS/tooling-configs/commit/52646de))
- Restore the rules Biome blocked and correctness does not ([8d9d531](https://github.com/AntelopeJS/tooling-configs/commit/8d9d531))
- Ignore the ajs binary by default" ([924ee36](https://github.com/AntelopeJS/tooling-configs/commit/924ee36))
- Leave Vue emit signatures alone ([8898c4f](https://github.com/AntelopeJS/tooling-configs/commit/8898c4f))

### 🤖 CI

- Add npm release workflow ([#2](https://github.com/AntelopeJS/tooling-configs/pull/2))

### ❤️ Contributors

- Antony Rizzitelli <rizzitelli.antony@pm.me>
- MrSociety404 <fabrice@altab.be>

## v0.0.2

[compare changes](https://github.com/AntelopeJS/tooling-configs/compare/v0.0.1...v0.0.2)

### 🩹 Fixes

- Leave the generated changelog alone ([26de107](https://github.com/AntelopeJS/tooling-configs/commit/26de107))
- Build before checking ([99b2d2d](https://github.com/AntelopeJS/tooling-configs/commit/99b2d2d))
- Lint from source, so releasing does not need a build first ([14572c7](https://github.com/AntelopeJS/tooling-configs/commit/14572c7))

### 🏡 Chore

- Stop committing dist ([b8b2089](https://github.com/AntelopeJS/tooling-configs/commit/b8b2089))

### ❤️ Contributors

- MrSociety404 <fabrice@altab.be>

## v0.0.1


### 🚀 Enhancements

- Shared oxlint and knip presets ([c020597](https://github.com/AntelopeJS/tooling-configs/commit/c020597))
- Let a repository stage import/no-cycle ([3780d6f](https://github.com/AntelopeJS/tooling-configs/commit/3780d6f))
- Add the oxfmt preset and drop Biome ([12c3d52](https://github.com/AntelopeJS/tooling-configs/commit/12c3d52))
- Add the shared Nuxt ESLint config ([893ffa0](https://github.com/AntelopeJS/tooling-configs/commit/893ffa0))
- Ignore the layer typecheck binary by default ([dcea0c2](https://github.com/AntelopeJS/tooling-configs/commit/dcea0c2))
- Stage the rules type-aware linting brings with it ([653e568](https://github.com/AntelopeJS/tooling-configs/commit/653e568))

### 🩹 Fixes

- Export the preset's ignore patterns ([3d31ee0](https://github.com/AntelopeJS/tooling-configs/commit/3d31ee0))
- Add extra oxfmt ignores instead of replacing them ([7c511e9](https://github.com/AntelopeJS/tooling-configs/commit/7c511e9))
- Stop listing src/index.ts as a Knip entry ([66ff4c6](https://github.com/AntelopeJS/tooling-configs/commit/66ff4c6))
- Fail on correctness, stop bundling perfectionist ([665c978](https://github.com/AntelopeJS/tooling-configs/commit/665c978))
- Honour the underscore convention in no-unused-vars ([33f8f73](https://github.com/AntelopeJS/tooling-configs/commit/33f8f73))

### 📦 Build

- Commit dist for the git install path ([77e1f03](https://github.com/AntelopeJS/tooling-configs/commit/77e1f03))

### 🏡 Chore

- **release:** Configure release-it ([d079f3a](https://github.com/AntelopeJS/tooling-configs/commit/d079f3a))

### ❤️ Contributors

- Antony Rizzitelli <rizzitelli.antony@pm.me>
- MrSociety404 <fabrice@altab.be>

