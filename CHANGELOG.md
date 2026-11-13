# Changelog

## v0.5.8

[compare changes](https://github.com/AntelopeJS/tooling-configs/compare/v0.5.7...v0.5.8)

### 🤖 CI

- Run the pack's checks on Windows and report stack repos without Windows CI ([#317](https://github.com/AntelopeJS/tooling-configs/pull/317))

### ❤️ Contributors

- Antony Rizzitelli ([@Upd4ting](http://github.com/Upd4ting))

## v0.5.7

[compare changes](https://github.com/AntelopeJS/tooling-configs/compare/v0.5.6...v0.5.7)

### 🚀 Enhancements

- **docs:** List mysql among the Database providers ([#324](https://github.com/AntelopeJS/tooling-configs/pull/324))
- **verify:** Pass a service's args to its container after the image ([#325](https://github.com/AntelopeJS/tooling-configs/pull/325))

### 🩹 Fixes

- **api-diff:** Skip packages outside the repository's workspace ([#322](https://github.com/AntelopeJS/tooling-configs/pull/322))
- **sync:** Keep nested pnpm installs in their own project ([#323](https://github.com/AntelopeJS/tooling-configs/pull/323))

### ❤️ Contributors

- Antony Rizzitelli ([@Upd4ting](http://github.com/Upd4ting))

## v0.5.6

[compare changes](https://github.com/AntelopeJS/tooling-configs/compare/v0.5.5...v0.5.6)

### 🩹 Fixes

- **sync:** Move a module's range for the interface released beside it ([#314](https://github.com/AntelopeJS/tooling-configs/pull/314))

### 📖 Documentation

- **readme:** Adopt the AntelopeJS framework README style ([#316](https://github.com/AntelopeJS/tooling-configs/pull/316))

### ❤️ Contributors

- Antony Rizzitelli ([@Upd4ting](http://github.com/Upd4ting))

## v0.5.5

[compare changes](https://github.com/AntelopeJS/tooling-configs/compare/v0.5.4...v0.5.5)

### 🚀 Enhancements

- **docs:** Generate the framework module table and the framework strip banner ([#315](https://github.com/AntelopeJS/tooling-configs/pull/315))

### ❤️ Contributors

- Antony Rizzitelli ([@Upd4ting](http://github.com/Upd4ting))

## v0.5.4

[compare changes](https://github.com/AntelopeJS/tooling-configs/compare/v0.5.3...v0.5.4)

### 🩹 Fixes

- **sync:** Align catalog: and plain pack specs across workspace members in --init ([#311](https://github.com/AntelopeJS/tooling-configs/pull/311))
- **sync:** Let pnpm 11 install the capture peer mongodb-memory-server without ERR_PNPM_IGNORED_BUILDS ([#310](https://github.com/AntelopeJS/tooling-configs/pull/310))
- **sync:** Move npm, yarn and bun repositories to pnpm in --init ([#313](https://github.com/AntelopeJS/tooling-configs/pull/313))
- **sync:** Bake the pack's packageManager into dist so a pnpm-packed tarball syncs ([#312](https://github.com/AntelopeJS/tooling-configs/pull/312))

### ❤️ Contributors

- Antony Rizzitelli ([@Upd4ting](http://github.com/Upd4ting))

## v0.5.3

[compare changes](https://github.com/AntelopeJS/tooling-configs/compare/v0.5.2...v0.5.3)

### 🚀 Enhancements

- **garden:** Check default branch protection on every repository ([#302](https://github.com/AntelopeJS/tooling-configs/pull/302))
- **garden:** Audit repository administrators per person ([#309](https://github.com/AntelopeJS/tooling-configs/pull/309))

### 🩹 Fixes

- **sync:** Drop the redundant checks job in the run that adds renovate-sync ([#301](https://github.com/AntelopeJS/tooling-configs/pull/301))
- **sync:** Report checks steps antelopejs-checks does not run ([#304](https://github.com/AntelopeJS/tooling-configs/pull/304))
- **sync:** Name docs-typescript-project when --init enables the docs check over TypeScript fences ([#303](https://github.com/AntelopeJS/tooling-configs/pull/303))
- **sync:** Make --init onboard a bare JavaScript repository to a green ci / checks ([#306](https://github.com/AntelopeJS/tooling-configs/pull/306))
- **sync:** Let pnpm 11 install lefthook without ERR_PNPM_IGNORED_BUILDS ([#307](https://github.com/AntelopeJS/tooling-configs/pull/307))
- **sync:** Align workspace members and move their oxlint options to flags in --init ([#305](https://github.com/AntelopeJS/tooling-configs/pull/305))

### 💅 Refactors

- **garden:** ⚠️  Drop the NEXT_AUTOMERGE pause machinery ([#308](https://github.com/AntelopeJS/tooling-configs/pull/308))

#### ⚠️ Breaking Changes

- **garden:** ⚠️  Drop the NEXT_AUTOMERGE pause machinery ([#308](https://github.com/AntelopeJS/tooling-configs/pull/308))

### ❤️ Contributors

- Antony Rizzitelli ([@Upd4ting](http://github.com/Upd4ting))

## v0.5.2

[compare changes](https://github.com/AntelopeJS/tooling-configs/compare/v0.5.1...v0.5.2)

### 🚀 Enhancements

- **sync:** Onboard a repository in one command with --init ([#299](https://github.com/AntelopeJS/tooling-configs/pull/299))

### 🔥 Performance

- **ci:** Refresh test shard weights from the last 10 main runs ([#294](https://github.com/AntelopeJS/tooling-configs/pull/294))

### 🩹 Fixes

- **sync:** Show workspace as the tested version of a linked sibling ([#295](https://github.com/AntelopeJS/tooling-configs/pull/295))
- **checks:** Run typecheck before the other steps when it writes files they read ([#296](https://github.com/AntelopeJS/tooling-configs/pull/296))
- **ci:** Weigh typecheck-writes.test.ts from the last 10 main runs ([#300](https://github.com/AntelopeJS/tooling-configs/pull/300))

### 📖 Documentation

- **readme:** Describe the no-unknown-parameters and no-runtime-typeof behaviour since #281 ([#293](https://github.com/AntelopeJS/tooling-configs/pull/293), [#281](https://github.com/AntelopeJS/tooling-configs/issues/281))

### 🤖 CI

- Fail when a test file has no shard weight ([#298](https://github.com/AntelopeJS/tooling-configs/pull/298))

### ❤️ Contributors

- Antony Rizzitelli ([@Upd4ting](http://github.com/Upd4ting))

## v0.5.1

[compare changes](https://github.com/AntelopeJS/tooling-configs/compare/v0.5.0...v0.5.1)

### 🚀 Enhancements

- **checks:** Fail when the repository's git config sets a commit identity ([#280](https://github.com/AntelopeJS/tooling-configs/pull/280))
- **sync:** Write the AntelopeJS DMS module table ([#279](https://github.com/AntelopeJS/tooling-configs/pull/279))
- **anti-slop:** Trust only schema-library decoders and report typeof in messages ([#281](https://github.com/AntelopeJS/tooling-configs/pull/281))
- **sync:** Fail --check on the release-typecheck and skipLibCheck rules ([#282](https://github.com/AntelopeJS/tooling-configs/pull/282))
- **verify:** Store the judgement and render the verdict in one command ([#286](https://github.com/AntelopeJS/tooling-configs/pull/286))
- **rules:** Report a read followed by an unguarded insert on the same table ([#287](https://github.com/AntelopeJS/tooling-configs/pull/287))

### 🔥 Performance

- **sync:** Parse each pnpm lockfile once per run ([#288](https://github.com/AntelopeJS/tooling-configs/pull/288))
- **lint:** Share parsed source files across the object-assign rule's programs ([#289](https://github.com/AntelopeJS/tooling-configs/pull/289))

### 🩹 Fixes

- **garden:** Exempt the repository publishing tooling-configs from the dependency check ([#283](https://github.com/AntelopeJS/tooling-configs/pull/283))
- **garden:** Exempt tooling-configs from the ci-caller conformance check ([#285](https://github.com/AntelopeJS/tooling-configs/pull/285))
- **guardrails:** Accept Object.prototype name guards in no-inherited-key-lookup ([#291](https://github.com/AntelopeJS/tooling-configs/pull/291))
- **lease:** Stop the Mongo test depending on a released port ([#292](https://github.com/AntelopeJS/tooling-configs/pull/292))
- **verify:** Read declarations instead of instantiating types so the declared-surface walk terminates ([#290](https://github.com/AntelopeJS/tooling-configs/pull/290))

### 📖 Documentation

- **readme:** Document the scheduled antelope-lock/ modules update in the guardrail pack ([#284](https://github.com/AntelopeJS/tooling-configs/pull/284))

### ❤️ Contributors

- Antony Rizzitelli ([@Upd4ting](http://github.com/Upd4ting))

## v0.5.0

[compare changes](https://github.com/AntelopeJS/tooling-configs/compare/v0.4.1...v0.5.0)

### 🚀 Enhancements

- **rules:** Report Object.assign writing an unknown or any value over a typed field ([#262](https://github.com/AntelopeJS/tooling-configs/pull/262))

### 🔥 Performance

- **verify:** Let the built-in template journeys share the scaffolded project ([#219](https://github.com/AntelopeJS/tooling-configs/pull/219))
- **verify:** Hard-link shared files when copying a prepared folder ([#221](https://github.com/AntelopeJS/tooling-configs/pull/221))

### 🩹 Fixes

- **docs:** Retry the Vale download and fail the step when it cannot ([#240](https://github.com/AntelopeJS/tooling-configs/pull/240))
- **lint:** Exempt only root sync-written configs from require-tsconfig-include ([#246](https://github.com/AntelopeJS/tooling-configs/pull/246))
- **sync:** Write the suppression budget under the template profile ([#242](https://github.com/AntelopeJS/tooling-configs/pull/242))
- **body-check:** Read suppression rows only from the suppression table ([#268](https://github.com/AntelopeJS/tooling-configs/pull/268))
- **verify:** Record SIGINT as sent only when stop delivers it ([#261](https://github.com/AntelopeJS/tooling-configs/pull/261))
- **api-diff:** Resolve type roots from each package's tsconfig directory ([#254](https://github.com/AntelopeJS/tooling-configs/pull/254))
- **api-diff:** Order same-named declaration blocks by their text ([#267](https://github.com/AntelopeJS/tooling-configs/pull/267))
- **lint:** Report self-imports in tests run by ajs module test even when self-linked ([#229](https://github.com/AntelopeJS/tooling-configs/pull/229))
- **guardrails:** Keep tracked node_modules symlinks in proof worktrees ([#239](https://github.com/AntelopeJS/tooling-configs/pull/239))
- **sync:** Fall back to a home bin directory when corepack cannot enable globally ([#220](https://github.com/AntelopeJS/tooling-configs/pull/220))
- **verify:** Point seeded .bin shims at their own project cache ([#224](https://github.com/AntelopeJS/tooling-configs/pull/224))
- **guardrails:** Locate require-assertion's assertions by ancestry so the rule works under ESLint ([#238](https://github.com/AntelopeJS/tooling-configs/pull/238))
- **anti-slop:** Report instanceof Function and Object in no-runtime-typeof ([#255](https://github.com/AntelopeJS/tooling-configs/pull/255))
- **api-diff:** Build with the package manager the workspace root declares ([#256](https://github.com/AntelopeJS/tooling-configs/pull/256))
- **sync:** Link .claude/skills to the own skill under --verify custom ([#259](https://github.com/AntelopeJS/tooling-configs/pull/259))
- **api-diff:** Stop the wildcard walk at a link back into a directory it is inside ([#252](https://github.com/AntelopeJS/tooling-configs/pull/252))
- **anti-slop:** Let no-chained-type-assertions pass a phantom retype of this ([#258](https://github.com/AntelopeJS/tooling-configs/pull/258))
- **checks:** Run an optional checks:prepare script before the parallel steps ([#274](https://github.com/AntelopeJS/tooling-configs/pull/274))
- **verify:** Keep no module cache when one non-ajs command installs several modules ([#223](https://github.com/AntelopeJS/tooling-configs/pull/223))
- **sync:** Keep comments under an empty key in place when rewriting ci.yml ([#233](https://github.com/AntelopeJS/tooling-configs/pull/233))
- **comment-proof:** Emit with the pack's TypeScript when the package's has no compiler API ([#228](https://github.com/AntelopeJS/tooling-configs/pull/228))
- **verify:** Load companion modules in the module kind's fixture project ([#251](https://github.com/AntelopeJS/tooling-configs/pull/251))
- **verify:** Let context.dev drive a template that is not an ajs project ([#241](https://github.com/AntelopeJS/tooling-configs/pull/241))
- **verify:** Clean refuses shared run folders and other checkouts' runs ([#218](https://github.com/AntelopeJS/tooling-configs/pull/218))
- **ratchet:** Link gitignored entries into the staged baseline tree ([#270](https://github.com/AntelopeJS/tooling-configs/pull/270))
- **api-diff:** Describe wildcard runtime entries that print or exit on import ([#237](https://github.com/AntelopeJS/tooling-configs/pull/237))
- **docs:** Check the module's own version in config examples ([#253](https://github.com/AntelopeJS/tooling-configs/pull/253))
- **verify:** Send request headers through JourneyContext.http ([#248](https://github.com/AntelopeJS/tooling-configs/pull/248))
- **anti-slop:** Report JSDoc casts in JavaScript files without a SAFETY comment ([#249](https://github.com/AntelopeJS/tooling-configs/pull/249))
- **capture:** Play each screenshot scene in a fresh context seeded with the setup session ([#271](https://github.com/AntelopeJS/tooling-configs/pull/271))
- **checks:** Fail a lockfile that resolves an interface package at two versions ([#257](https://github.com/AntelopeJS/tooling-configs/pull/257))
- **checks:** Split readiness out of verify context and guard the bench site address ([#277](https://github.com/AntelopeJS/tooling-configs/pull/277))
- **capture:** Refuse an unbuilt module and keep the demo logs on failure ([#269](https://github.com/AntelopeJS/tooling-configs/pull/269))
- **verify:** Drive an interface of the module's own package without a self link ([#247](https://github.com/AntelopeJS/tooling-configs/pull/247))
- **verify:** Keep the registry modules of a cache that also holds a git module ([#225](https://github.com/AntelopeJS/tooling-configs/pull/225))
- **guardrails:** Let comment-proof skip a workspace base tsconfig and resolve tsconfig types per package ([#234](https://github.com/AntelopeJS/tooling-configs/pull/234))
- **verify:** Create module templates with ajs module init ([#250](https://github.com/AntelopeJS/tooling-configs/pull/250))
- **api-diff:** Follow `@/` path aliases in declarations and at runtime ([#235](https://github.com/AntelopeJS/tooling-configs/pull/235))
- **comment-proof:** Skip a package whose tsconfig extends an uncommitted file ([#230](https://github.com/AntelopeJS/tooling-configs/pull/230))
- **api-diff:** Fail declaration errors only in modules a published entry reaches ([#245](https://github.com/AntelopeJS/tooling-configs/pull/245))
- **docs:** Flag framework and tool versions in standard-mode prose ([#273](https://github.com/AntelopeJS/tooling-configs/pull/273))
- **verify:** Report a registry outage as NOT VERIFIED only after a live probe ([#222](https://github.com/AntelopeJS/tooling-configs/pull/222))
- **eslint:** Run the type-aware rules on Vue script blocks ([#226](https://github.com/AntelopeJS/tooling-configs/pull/226))
- **sync:** Write the scripts checks runs under the template profile ([#227](https://github.com/AntelopeJS/tooling-configs/pull/227))
- **guardrails:** Report computed destructures, unknown aliases and unguarded reads in no-inherited-key-lookup ([#264](https://github.com/AntelopeJS/tooling-configs/pull/264))
- **guardrails:** Measure staged files the working tree deleted or changed after staging ([#265](https://github.com/AntelopeJS/tooling-configs/pull/265))
- **formal:** Deterministic BROKEN traces and violating-state counts for findings ([#266](https://github.com/AntelopeJS/tooling-configs/pull/266))
- **api-diff:** Build each revision against its own workspace packages ([#272](https://github.com/AntelopeJS/tooling-configs/pull/272))
- **verify:** Narrow the probe test's server address with a type guard ([#278](https://github.com/AntelopeJS/tooling-configs/pull/278))
- **sync:** Add the capture tool's optional peers to repos with docs/captures.ts ([#263](https://github.com/AntelopeJS/tooling-configs/pull/263))
- **verify:** Seed prepared copies from the run's module cache ([#217](https://github.com/AntelopeJS/tooling-configs/pull/217))
- **lint:** Report a tsconfig that lists no types under type-aware lint ([#232](https://github.com/AntelopeJS/tooling-configs/pull/232))

### ❤️ Contributors

- Antony Rizzitelli ([@Upd4ting](http://github.com/Upd4ting))

## v0.4.1

[compare changes](https://github.com/AntelopeJS/tooling-configs/compare/v0.4.0...v0.4.1)

### 🩹 Fixes

- **checks:** Find tsc on TypeScript 7 through its package.json ([#276](https://github.com/AntelopeJS/tooling-configs/pull/276))

### ❤️ Contributors

- Antony Rizzitelli ([@Upd4ting](http://github.com/Upd4ting))

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

