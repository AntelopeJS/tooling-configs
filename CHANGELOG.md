# Changelog

## v0.4.0

[compare changes](https://github.com/AntelopeJS/tooling-configs/compare/v0.3.8...v0.4.0)

### 💅 Refactors

- **verify:** ⚠️  Remove publish, its evidence branch, comment and status ([#275](https://github.com/AntelopeJS/tooling-configs/pull/275))

#### ⚠️ Breaking Changes

- **verify:** ⚠️  Remove publish, its evidence branch, comment and status ([#275](https://github.com/AntelopeJS/tooling-configs/pull/275))

### ❤️ Contributors

- Antony Rizzitelli ([@Upd4ting](http://github.com/Upd4ting))

## v0.3.8

[compare changes](https://github.com/AntelopeJS/tooling-configs/compare/v0.3.7...v0.3.8)

### 🩹 Fixes

- **verify:** Record processes per command and bound interrupts under --jobs ([#216](https://github.com/AntelopeJS/tooling-configs/pull/216))

### ❤️ Contributors

- Antony Rizzitelli ([@Upd4ting](http://github.com/Upd4ting))

## v0.3.7

[compare changes](https://github.com/AntelopeJS/tooling-configs/compare/v0.3.6...v0.3.7)

### 🔥 Performance

- **verify:** Run features concurrently with journey --jobs ([#215](https://github.com/AntelopeJS/tooling-configs/pull/215))

### 🩹 Fixes

- **verify:** Fail a formal check whose own edit breaks a rule the base did not ([#206](https://github.com/AntelopeJS/tooling-configs/pull/206))
- **verify:** Match dotfiles in verify globs ([#213](https://github.com/AntelopeJS/tooling-configs/pull/213))

### ❤️ Contributors

- Antony Rizzitelli ([@Upd4ting](http://github.com/Upd4ting))

## v0.3.6

[compare changes](https://github.com/AntelopeJS/tooling-configs/compare/v0.3.5...v0.3.6)

### 🚀 Enhancements

- **verify:** Accept a covered formal check that breaks the same recorded findings as base ([#203](https://github.com/AntelopeJS/tooling-configs/pull/203))
- **checks:** Type-check verify layers and their lockfiles ([#205](https://github.com/AntelopeJS/tooling-configs/pull/205))
- **sync:** Report when build or release can skip what typecheck checks ([#211](https://github.com/AntelopeJS/tooling-configs/pull/211))
- **sync:** Turn the CI test job off when the test script is a placeholder ([#214](https://github.com/AntelopeJS/tooling-configs/pull/214))

### 🔥 Performance

- **verify:** Call the verify CLI through node_modules/.bin in the synced skills ([#207](https://github.com/AntelopeJS/tooling-configs/pull/207))
- **verify:** Run every planned feature in one journey call ([#209](https://github.com/AntelopeJS/tooling-configs/pull/209))
- **verify:** Reuse the cached tarball of a published interface version ([#210](https://github.com/AntelopeJS/tooling-configs/pull/210))
- **verify:** Probe app readiness every 25 ms while it starts ([#212](https://github.com/AntelopeJS/tooling-configs/pull/212))

### 🩹 Fixes

- **verify:** Count a single-interface module's src/interface as shared ([#208](https://github.com/AntelopeJS/tooling-configs/pull/208))

### 📖 Documentation

- **readme:** Recommend oxfmt 0.77, the version the preset moved to ([#202](https://github.com/AntelopeJS/tooling-configs/pull/202))

### ❤️ Contributors

- Antony Rizzitelli ([@Upd4ting](http://github.com/Upd4ting))

## v0.3.5

[compare changes](https://github.com/AntelopeJS/tooling-configs/compare/v0.3.4...v0.3.5)

### 🚀 Enhancements

- **verify:** Time each phase of a run and show it in the verdict ([#186](https://github.com/AntelopeJS/tooling-configs/pull/186))

### 🔥 Performance

- **verify:** Prepare a project once per run and copy it per journey ([#197](https://github.com/AntelopeJS/tooling-configs/pull/197))
- **verify:** Install a project's registry modules once per run ([#200](https://github.com/AntelopeJS/tooling-configs/pull/200))

### 🩹 Fixes

- **verify:** Run journeys, setup and formal checks in the operator's environment, not the lease's ([#198](https://github.com/AntelopeJS/tooling-configs/pull/198))

### ❤️ Contributors

- Antony Rizzitelli ([@Upd4ting](http://github.com/Upd4ting))

## v0.3.4

[compare changes](https://github.com/AntelopeJS/tooling-configs/compare/v0.3.3...v0.3.4)

### 🚀 Enhancements

- **sync:** Drop the caller checks job that only re-aggregates ci ([#189](https://github.com/AntelopeJS/tooling-configs/pull/189))
- **verify:** Run every feature when a shared file changes or before a release ([#188](https://github.com/AntelopeJS/tooling-configs/pull/188))
- **lease:** Stop only this worktree's own work with down --stop ([#196](https://github.com/AntelopeJS/tooling-configs/pull/196))

### 🔥 Performance

- **checks:** Run the check steps concurrently ([#190](https://github.com/AntelopeJS/tooling-configs/pull/190))
- **verify:** Build an interface once when its prepack is the build ([#192](https://github.com/AntelopeJS/tooling-configs/pull/192))
- **verify:** Reuse a passed journey of another feature within one run ([#194](https://github.com/AntelopeJS/tooling-configs/pull/194))
- **fmt:** Move to oxfmt 0.77, which formats Markdown without a Node worker pool ([#195](https://github.com/AntelopeJS/tooling-configs/pull/195))
- **formal:** Cache checkSpec results by everything TLC reads ([#199](https://github.com/AntelopeJS/tooling-configs/pull/199))

### 🩹 Fixes

- **garden:** Start the ci-duration baseline after the last change to the CI caller or its reusable workflows ([#187](https://github.com/AntelopeJS/tooling-configs/pull/187))
- **sync:** Install lefthook hooks from prepare only at the git top level ([#191](https://github.com/AntelopeJS/tooling-configs/pull/191))
- **verify:** Stop forcing prefer-offline on the shared npm cache ([#193](https://github.com/AntelopeJS/tooling-configs/pull/193))
- **verify:** Raise the open-file limit of service containers ([#201](https://github.com/AntelopeJS/tooling-configs/pull/201))

### 🤖 CI

- Balance test shards by measured file duration ([#185](https://github.com/AntelopeJS/tooling-configs/pull/185))

### ❤️ Contributors

- Antony Rizzitelli ([@Upd4ting](http://github.com/Upd4ting))

## v0.3.3

[compare changes](https://github.com/AntelopeJS/tooling-configs/compare/v0.3.2...v0.3.3)

### 🚀 Enhancements

- **sync:** Write and check renovate.json extending the AntelopeJS preset ([#184](https://github.com/AntelopeJS/tooling-configs/pull/184))

### 🤖 CI

- Report the gate as ci / checks ([#183](https://github.com/AntelopeJS/tooling-configs/pull/183))

### ❤️ Contributors

- Antony Rizzitelli ([@Upd4ting](http://github.com/Upd4ting))

## v0.3.2

[compare changes](https://github.com/AntelopeJS/tooling-configs/compare/v0.3.1...v0.3.2)

### 🚀 Enhancements

- **checks:** Start the .github/compose.yml services for local runs ([#179](https://github.com/AntelopeJS/tooling-configs/pull/179))
- **triage:** Rank untriaged community issues with antelopejs-triage ([#182](https://github.com/AntelopeJS/tooling-configs/pull/182))

### 🩹 Fixes

- **verify:** State that scaffolds ship without the agent layer in verify-template ([#181](https://github.com/AntelopeJS/tooling-configs/pull/181))
- **verify:** Delete each journey's install when it ends and prune stale runs ([#180](https://github.com/AntelopeJS/tooling-configs/pull/180))

### ❤️ Contributors

- Antony Rizzitelli ([@Upd4ting](http://github.com/Upd4ting))

## v0.3.1

[compare changes](https://github.com/AntelopeJS/tooling-configs/compare/v0.3.0...v0.3.1)

### 🏡 Chore

- **sync:** Stop writing the weekly mutation caller ([#178](https://github.com/AntelopeJS/tooling-configs/pull/178))

### ❤️ Contributors

- Antony Rizzitelli ([@Upd4ting](http://github.com/Upd4ting))

## v0.3.0

[compare changes](https://github.com/AntelopeJS/tooling-configs/compare/v0.2.19...v0.3.0)

### 🚀 Enhancements

- **verify:** ⚠️  Remove the seeded, seeded-doors and containments commands ([#176](https://github.com/AntelopeJS/tooling-configs/pull/176))

### 🩹 Fixes

- **garden:** Stop requiring a verify-gate check ([#175](https://github.com/AntelopeJS/tooling-configs/pull/175))

### 🤖 CI

- **release:** Accept an exact release version ([#177](https://github.com/AntelopeJS/tooling-configs/pull/177))

#### ⚠️ Breaking Changes

- **verify:** ⚠️  Remove the seeded, seeded-doors and containments commands ([#176](https://github.com/AntelopeJS/tooling-configs/pull/176))

### ❤️ Contributors

- Antony Rizzitelli ([@Upd4ting](http://github.com/Upd4ting))

## v0.2.19

[compare changes](https://github.com/AntelopeJS/tooling-configs/compare/v0.2.18...v0.2.19)

### 🚀 Enhancements

- **garden:** Prune stale branches and enforce delete_branch_on_merge ([#169](https://github.com/AntelopeJS/tooling-configs/pull/169))
- **lease:** Lease ports, Mongo and run dirs per git worktree ([#173](https://github.com/AntelopeJS/tooling-configs/pull/173))
- **sync:** Pass test-job: true from the generated CI caller ([#174](https://github.com/AntelopeJS/tooling-configs/pull/174))

### 🔥 Performance

- **checks:** Run tests beside the other checks, in balanced shards ([#172](https://github.com/AntelopeJS/tooling-configs/pull/172))

### 🩹 Fixes

- **sync:** Check the template agent layer only in the template source ([#170](https://github.com/AntelopeJS/tooling-configs/pull/170))

### 📖 Documentation

- **verify:** Record the browser driver choice ([#171](https://github.com/AntelopeJS/tooling-configs/pull/171))

### ❤️ Contributors

- Antony Rizzitelli ([@Upd4ting](http://github.com/Upd4ting))

## v0.2.18

[compare changes](https://github.com/AntelopeJS/tooling-configs/compare/v0.2.17...v0.2.18)

### 🩹 Fixes

- **suppressions:** Count directives and size in repo-authored agent files ([#84](https://github.com/AntelopeJS/tooling-configs/pull/84))

### 📖 Documentation

- **guardrails:** List per-step checks to run while iterating ([#86](https://github.com/AntelopeJS/tooling-configs/pull/86))
- **readme:** Use one Discord invite ([#123](https://github.com/AntelopeJS/tooling-configs/pull/123))
- **github:** Send questions and ideas to Discord ([#145](https://github.com/AntelopeJS/tooling-configs/pull/145))

### 🏡 Chore

- Land the cleanup campaign on main ([#167](https://github.com/AntelopeJS/tooling-configs/pull/167))

### ❤️ Contributors

- Antony Rizzitelli ([@Upd4ting](http://github.com/Upd4ting))

## v0.2.17

[compare changes](https://github.com/AntelopeJS/tooling-configs/compare/v0.2.16...v0.2.17)

### 🚀 Enhancements

- **lint:** Reject any and once-used type parameters standing in for unknown ([#69](https://github.com/AntelopeJS/tooling-configs/pull/69))
- **sync:** Restore the DMS backend boundary plugin from the pack ([#72](https://github.com/AntelopeJS/tooling-configs/pull/72))
- **docs:** Typecheck every TypeScript fence against the repo's own source ([#67](https://github.com/AntelopeJS/tooling-configs/pull/67))
- **docs:** Fail @antelopejs version prose outside the generated compatibility block ([#71](https://github.com/AntelopeJS/tooling-configs/pull/71))
- **sync:** Generate the docs-compat block and the caller's docs-files ([#68](https://github.com/AntelopeJS/tooling-configs/pull/68))
- **anti-slop:** Exempt boundary parameters, rejection reasons and type-guard records ([#81](https://github.com/AntelopeJS/tooling-configs/pull/81))
- **guardrails:** Ratchet --update adopts only the rules a pack release newly enabled ([#78](https://github.com/AntelopeJS/tooling-configs/pull/78))
- **api-diff:** Compare the names and signatures DMS frontend modules auto-import ([#73](https://github.com/AntelopeJS/tooling-configs/pull/73))
- **lint:** Flag inherited-key lookups and presence-only type guards ([#70](https://github.com/AntelopeJS/tooling-configs/pull/70))
- **guardrails:** Check PR-body proof tables and findings lists against HEAD ([#82](https://github.com/AntelopeJS/tooling-configs/pull/82))

### 🩹 Fixes

- **suppressions:** Count lint config rule-offs against the budget ([#66](https://github.com/AntelopeJS/tooling-configs/pull/66))
- **guardrails:** Compare the staged ratchet with the merge-base of the pull request base ([#65](https://github.com/AntelopeJS/tooling-configs/pull/65))
- **sync:** Fail a CI caller whose gate reads needs of a job it does not need ([#79](https://github.com/AntelopeJS/tooling-configs/pull/79))
- **oxc:** Ignore only the agent files sync writes, and type the skill's own files ([#80](https://github.com/AntelopeJS/tooling-configs/pull/80))
- **suppressions:** Fail dead and reasonless directives in files a change touches ([#83](https://github.com/AntelopeJS/tooling-configs/pull/83))

### ❤️ Contributors

- Antony Rizzitelli ([@Upd4ting](http://github.com/Upd4ting))

## v0.2.16

[compare changes](https://github.com/AntelopeJS/tooling-configs/compare/v0.2.15...v0.2.16)

### 🩹 Fixes

- **verify:** Close the residual emit holes and sync rename leftovers ([#64](https://github.com/AntelopeJS/tooling-configs/pull/64))

### ❤️ Contributors

- Antony Rizzitelli ([@Upd4ting](http://github.com/Upd4ting))

## v0.2.15

[compare changes](https://github.com/AntelopeJS/tooling-configs/compare/v0.2.14...v0.2.15)

### 🩹 Fixes

- **verify:** Require containments to fail with their door, and follow-ups ([#62](https://github.com/AntelopeJS/tooling-configs/pull/62))

### ❤️ Contributors

- Antony Rizzitelli ([@Upd4ting](http://github.com/Upd4ting))

## v0.2.14

[compare changes](https://github.com/AntelopeJS/tooling-configs/compare/v0.2.13...v0.2.14)

### 🩹 Fixes

- **sync:** Grant write permissions only to the renovate-sync caller job ([#60](https://github.com/AntelopeJS/tooling-configs/pull/60))

### ❤️ Contributors

- Antony Rizzitelli ([@Upd4ting](http://github.com/Upd4ting))

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

