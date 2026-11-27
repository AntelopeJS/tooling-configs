---
name: formal-change-feed-delivery
description: Interleaving check, with fast-check and a partial-order-reduced step explorer, that a change feed of @antelopejs/mysql delivers every change committed after it opened, once and in per-row order, or ends with a loss error that names what went (the sequencer in src/implementations/database/sequencer.ts, the reaper in reaper.ts, the change clock in change-loop.ts, the feed open and poll in feeds.ts and feed-poll.ts, and their SQL in src/dialect/mysql/capture.ts). Use when a change touches any of those files or the change log's statements, or needs proof that a feed never skips, repeats or reorders an event.
---

# Formal check: change-feed delivery

A row trigger writes each change to `__antelope_changes` without a `seq`, in the writer's transaction. A sequencer pass locks the clock row, reads the rows still without a `seq` that had committed when the read began (one snapshot), numbers them from the clock in log order, and moves the clock, in one transaction. A feed opens by running a pass and taking the clock's frontier as its watermark, then polls the rows numbered above it. The reaper numbers, then deletes the numbered rows past retention, and raises each table's high-water so a feed that missed them ends with a loss error. `docs/change-feeds.md` states the promise this check guards.

**The property.** A feed delivers every change committed on its table and instance after its open read the frontier, exactly once, two changes of one document in the order they committed, and nothing else, unless it ends with a loss error that names the range that went.

**The harm.** A break loses, repeats or reorders an order, a payment or an audit event for every consumer that mirrors a table from its feed, and nothing fails: the feed keeps running.

The check runs the real `ReadFeedEvents`, `Sequence` and `ReapOnce` of `src/`, compiled with this folder, against `server.ts`, a fake server. `innodb.ts` holds the log, the clock and the reaped table under READ COMMITTED: a transaction's changes stay pending until it commits, a plain read sees the committed version, and a locking read or a write of a row another transaction holds waits or skips it. `statements.ts` recognises each statement of `capture.ts` by its SQL text, and `steps.ts` runs it as InnoDB does: one indivisible step per statement. A plain `SELECT` at READ COMMITTED reads one snapshot taken as it starts, so the sequencer's read of unnumbered rows is one step. A locking scan, which InnoDB reads row by row against the latest data, would be a step per row it visits; `steps.ts` keeps that model for the scratch change that restores `FOR UPDATE SKIP LOCKED`. A statement the table does not know stops the check with exit 2, so an edit to the SQL cannot pass unread. fast-check draws the scenarios with a fixed seed, and `explore.ts` runs each one under the orders of its steps that can change an outcome.

- `check.mjs` refuses to run when the code `check.ts` and `server.ts` copy has changed (see Scope), compiles this folder and the `src/` it imports into a scratch folder with the repository's `tsc`, runs `check.ts` there, and deletes the folder.
- `check.ts` runs a scenario: seeded changes, then writers, change-clock ticks, reaper passes and one feed, all started at once. Once every step has run, a last pass numbers what is left and the feed reads to the frontier. Then the rules judge the run.
- `rules.ts` holds the scenarios and the rules. `shards.ts` splits the scenarios across worker threads; the printed result does not depend on `--jobs`.
- `explore.ts` is the order explorer: dynamic partial-order reduction with sleep sets (Flanagan and Godefroid, POPL 2005). Each step names the resources it reads and writes, and the explorer runs another order only where two steps of different actors race on one resource. A step whose lock another transaction holds is not enabled, as a statement waiting on a lock does not run, and a step that raced while it waited is also tried where it could still run.

## Run it

From the repository root, with Node 22 or 24 and `pnpm install` done:

```sh
node .agents/skills/formal-change-feed-delivery/check.mjs          # CI bounds
node .agents/skills/formal-change-feed-delivery/check.mjs --full   # full bounds
```

`--scenarios <n>`, `--orders <n>` and `--seed <n>` override the bounds; each takes a positive integer. `--jobs <n>` sets how many worker threads explore the scenarios; it defaults to the available cores, at most 4. No database is needed.

| Bounds          | Scenario size                                                               | Scenarios | Orders per scenario, at most | Orders run | Cut short as covered | Scenarios cut at the cap | Wall time |
| --------------- | --------------------------------------------------------------------------- | --------- | ---------------------------- | ---------- | -------------------- | ------------------------ | --------- |
| CI (default)    | 0 to 1 seed, 1 to 2 writers of 1 write, 0 to 1 tick, 0 to 1 reaper          | 100       | 20,000                       | 270,941    | 108,437              | 12                       | 56 s      |
| Full (`--full`) | 0 to 2 seeds, 1 to 2 writers of 1 to 2 writes, 0 to 2 ticks, 0 to 2 reapers | 100       | 20,000                       | 679,984    | 287,553              | 39                       | 2 min 7 s |

Every scenario also draws a `changeBatchSize` of 1 to 3 and a retention of 0 or 30 steps. Times are with the default `--jobs` (4) on a shared 16-core machine, `tsc` included.

A scenario cut at the cap ran that many orders, not all of them: the orders it did not run are unchecked. The cut scenarios are the ones where a tick, a reaper and the feed's open race three passes over the log. Every other scenario ran every order that can change an outcome.

- Exit 0 means every rule that held still holds, and each finding still breaks.
- Exit 1 means a rule changed: a rule that held now breaks (`BROKEN`), or a finding now holds (`HOLDS`).
- Exit 2 means the check could not run: copied code changed, `tsc` failed, a statement is not in `statements.ts`, or the model reached a state it does not cover.

## The rules

| Rule                              | Holds when                                                                                                                                                   |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `DeliversEveryChange`             | Every change committed on the feed's table and instance after the open read the frontier is delivered, unless the feed ended as lapsed at or below its `seq` |
| `DeliversOnce`                    | No change is delivered twice                                                                                                                                 |
| `DeliversOnlyItsCommittedChanges` | Every delivered change committed, on the feed's table and instance                                                                                           |
| `SkipsChangesBeforeOpen`          | No change committed before the feed's first read began is delivered                                                                                          |
| `KeepsRowOrder`                   | Two changes of one document are delivered in the order they committed                                                                                        |
| `NumbersEachPassInLogOrder`       | One pass numbers the rows it takes in the order they were logged                                                                                             |
| `LapsesOnlyOnLoss`                | A feed ends as lapsed only when the reaper deleted a row of its table in the range it names, and ends with no other error                                    |
| `NamesTheLostRange`               | A loss error's range covers every row of the table reaped before the feed ended, from where the feed stood, and ends at the highest of them                  |
| `KeepsRetention`                  | The reaper deletes a row only once it has been numbered for longer than the retention                                                                        |
| `Settles`                         | Every actor finishes: no statement waits forever and no pass fails                                                                                           |

A change that commits while the open runs, after the feed's first read began and before the open read the frontier, may or may not be delivered: the docs promise neither.

## Findings

None at the sync commit. Every rule holds under both bounds.

`KeepsRowOrder` broke before PR #1 merged, and this check found it. The sequencer then read the unnumbered rows with `FOR UPDATE SKIP LOCKED`, which InnoDB reads row by row. A scan skipped a row whose transaction was still open. That transaction committed, and another writer changed the same document while the scan ran. The scan then numbered the later change first, and a feed delivered the two out of order. On MySQL 8.4.13 with the statements of `capture.ts`, the scan numbered w2 `seq` 1 and w1, which committed first, `seq` 2.

PR #1, merged as `0631d5f`, reads the unnumbered rows as one snapshot instead. The same run on MySQL 8.4.13 numbers w1 `seq` 1 and w2 `seq` 2: the snapshot taken before w1 committed sees neither row, and the next pass sees both. The first row of "Confirm the check can fail" restores the old scan and shows the check still catches it. With the CI scenarios run to 400,000 orders each, every rule still holds and 4 of the 100 scenarios reach that cap.

## Read a result

`holds` lists the rules that held, with the bounds. `BROKEN <rule>` or `finding <rule>` prints the scenario as JSON, the picks that replay its order, then one line per step: the actor, the statement in plain words, and what it answered. `=>` lines name what broke. The trace of the shortest counterexample is printed, the lowest scenario on a tie.

Then decide whether the code or the model is wrong:

1. Find the step where the run leaves the docs' promise, and the statement in `src/` that issued it. The labels name the `capture.ts` statement: `lock the clock` is `lockClock`, `select unnumbered rows` is one row of `unsequenced`, `number ids` is `stamp`, `move the clock` is `advance`, `read the frontier` is `frontier`, `poll` is `poll`, `find what is past retention` is `reapThrough`, `raise the high-water` is `raiseReaped`, `delete through seq` is `reap`.
2. Ask whether MySQL 8.4 would answer that statement as the trace says, in that state. Check `steps.ts` against the MySQL reference for the clause in question: READ COMMITTED reads, `SKIP LOCKED`, the locks an `UPDATE`, `DELETE` or `INSERT ... ON DUPLICATE KEY UPDATE` takes. When in doubt, replay the steps on a real server, as the finding above was. If MySQL would answer otherwise, the model is wrong: fix `steps.ts`, and rerun every row of "Confirm the check can fail".
3. Ask whether the scenario could happen: the writers, ticks, reapers and feed are concurrent in production, and `check.ts` starts them as production does. A run that only a wrong scenario reaches is a modelling error too.
4. Otherwise the code breaks the promise. Report it with the trace, and do not weaken a rule or the model to make it pass. To record it as a known finding, add the rule to `FINDINGS` in `check.ts` and describe it under Findings.

A footprint that is too small in `steps.ts`, `server.ts` or `check.ts` makes the explorer skip orders, and the check then passes on code it would fail. When you add or change a step, give it every resource its outcome depends on, and its blocked check every lock it waits on. Then compare the explorer with full enumeration: make `dependent` in `explore.ts` answer `true` in a scratch copy, run both on scenarios small enough to finish, and compare the outcomes each reaches. At `0631d5f`, before any step or footprint changed since, 19 drawn scenarios that finish without reduction reached the same outcomes both ways, and so did a two-writer scenario of one document: 34 outcomes, in 82,598 orders without reduction and under a thousand with it.

## Scope and assumptions

What the check covers, at the sync commit:

| File                                          | What runs                                     | Functions                                                                                                                                                                                                                                                                          |
| --------------------------------------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/implementations/database/feeds.ts`       | the real code                                 | `ReadFeedEvents`, `Advance`, `Open`, `Polled`, `Poll`, `Waited`, `Wake`, `Retire`, `CloseOneFeed`                                                                                                                                                                                  |
| `src/implementations/database/feed-poll.ts`   | the real code                                 | `PollStatement`, `ReadPoll`                                                                                                                                                                                                                                                        |
| `src/implementations/database/sequencer.ts`   | the real code                                 | `Sequence`, `SequenceOnce`, `Numbered`, `InSessionTransaction`, `ReadFrontier`                                                                                                                                                                                                     |
| `src/implementations/database/reaper.ts`      | the real code                                 | `ReapOnce`, `ReapBatch`, `LockName`                                                                                                                                                                                                                                                |
| `src/dialect/mysql/capture.ts`                | its SQL, read by `statements.ts`              | `lockClock`, `unsequenced`, `stamp`, `advance`, `frontier` and `poll` (all but the projected documents, with the epoch read as the clock's own beside the log's identity and birth row), `reapThrough`, `raiseReaped` and `reap` (whose range starts past the birth row's `seq` 0) |
| `src/implementations/database/feeds.ts`       | copied in `server.ts`, guarded by `check.mjs` | `LIVE.open`: a `Sequence` pass that waits for the clock, then `ReadFrontier`                                                                                                                                                                                                       |
| `src/implementations/database/change-loop.ts` | copied in `check.ts`, guarded by `check.mjs`  | `Look`: read the frontier, and run a `Sequence` pass that skips a busy clock when rows wait                                                                                                                                                                                        |
| `src/implementations/database/change-loop.ts` | modelled in `server.ts`                       | `Announce`: the wake step, which the explorer may run whenever the feed waits and the polled state moved                                                                                                                                                                           |
| `src/dialect/mysql/capture.ts`                | modelled in `server.ts`                       | `Triggers`: each write inserts one log row in the writer's transaction, under the document's row lock                                                                                                                                                                              |

The real `LIVE.open` and `Look` take a pooled connection, so the check runs a copy of each. `check.mjs` holds the text of each copied part and exits 2 when the file no longer contains it: update the copy, then the text.

The model assumes:

- InnoDB at READ COMMITTED with record locks only. Every statement of the log uses its primary key, its unique `seq` key or `tbl_seq`, and the sequencer and the reaper set READ COMMITTED first. A `DELETE` waits on a locked row whose committed or pending `seq` is in its range.
- A plain `SELECT` reads one snapshot of the committed rows, taken as it starts. A locking scan visits rows in `id` order and judges each row when it reaches it, passing over a row that committed with a `seq` without a step, since only a pass, which holds the clock the scan holds, numbers a row.
- One tick of the fake clock per step. With a retention of 0, any numbered row can go at the reaper's next step. With a retention of 30, whether a row is old enough depends on how many steps ran, which the reduction ignores: those scenarios run some of the timings, not all.
- A writer locks its documents in one order, so writers never deadlock each other. InnoDB would roll one back, and a writer that rolls back is drawn already.

Left out, each covered by its own tests or not at all:

- Trigger swaps under `LOCK TABLES` (`ApplyTriggerSwap` in `change-log.ts`) and convergence, which `feeds-convergence.test.ts` covers on a real server.
- A log recreated, altered or emptied: the log's identity and birth row never change in a scenario, so the `restarted` ending is not reached, and the model answers the clock's epoch for the composite one. `feeds-log.test.ts` covers it on a real server.
- A document deeper than the server builds: no statement fails in a scenario, so a feed never polls one event at a time and never ends as too deep. `feeds-depth.test.ts` covers it.
- A declaration registered again while a feed is open: the origin never changes in a scenario, so `Polled` never compiles the stages again. `feeds-declaration.test.ts` covers it.
- Lost connections, failed statements and retried polls: no statement fails in a scenario unless the code issues one the model refuses.
- A backlog of more than 10,000 rows, which a pass numbers in several transactions.
- Filtered feeds, `CROSS_INSTANCE` feeds and the documents a poll projects: every side matches, and its document carries only the change's label.
- More than one feed, and more than two writers, two ticks or two reapers. Three writers with two ticks and two reapers left 52 of 300 scenarios cut at 50,000 orders in 17 minutes, too slow for a check run on every change.

## Confirm the check can fail

Each scratch change was applied to `src/` in a scratch worktree at the sync commit and run under the CI bounds. With the change dropped, the check exits 0 and every rule holds.

| Scratch change in the code                                                                  | Result, CI bounds                                                         |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `unsequenced` reads with `FOR UPDATE SKIP LOCKED` again, as before the fix (capture.ts:378) | `BROKEN KeepsRowOrder`                                                    |
| `Poll` moves the watermark to the frontier after a full batch (feeds.ts:339)                | `BROKEN DeliversEveryChange`                                              |
| `Poll` moves the watermark to one below the last row of a full batch (feeds.ts:339)         | `BROKEN DeliversOnce`                                                     |
| `Poll` ends the feed when its watermark equals the high-water (feeds.ts:319)                | `BROKEN LapsesOnlyOnLoss`                                                 |
| `Poll` names a lost range that ends 100 past the high-water (feeds.ts:320)                  | `BROKEN NamesTheLostRange`                                                |
| `Poll` names a lost range that ends where it starts (feeds.ts:320)                          | `BROKEN NamesTheLostRange`                                                |
| `ReapBatch` deletes without raising the high-water (reaper.ts:48)                           | `BROKEN DeliversEveryChange`                                              |
| `ReapBatch` passes a retention of 0 whatever it is given (reaper.ts:41)                     | `BROKEN KeepsRetention`                                                   |
| `unsequenced` numbers the newest row first (`ORDER BY id DESC`, capture.ts:378)             | `BROKEN NumbersEachPassInLogOrder`                                        |
| `SequenceOnce` runs its statements outside a transaction (sequencer.ts:112)                 | `BROKEN LapsesOnlyOnLoss`, `BROKEN Settles`                               |
| `Numbered` skips a busy clock even when the feed's open asks to wait (sequencer.ts:77)      | `BROKEN SkipsChangesBeforeOpen`                                           |
| `Numbered` moves the clock one short of the rows it numbered (sequencer.ts:87)              | `BROKEN DeliversEveryChange`, `BROKEN LapsesOnlyOnLoss`, `BROKEN Settles` |
| `LIVE.open` skips a busy clock (feeds.ts:94)                                                | exit 2: the copied open no longer matches                                 |
| `Look` reads the frontier without numbering (change-loop.ts:73)                             | exit 2: the copied look no longer matches                                 |
| `poll` reads `id` as `seq` (capture.ts:309)                                                 | exit 2: the model does not know the statement                             |

Each `BROKEN` run exited 1.

The rules a run reports depend on the first scenario that breaks one, so a row lists what that scenario broke.

## Keep it in step

Sync commit: `7d0dfe4`. At that commit the model and the covered files above describe the same code.

When a change touches a covered file:

1. Run both bounds. A `BROKEN` rule is a bug in the change until the steps in "Read a result" show it is the model's. A `HOLDS <rule>` for a recorded finding means no explored order breaks it any more. When the line says unconfirmed, scenarios were cut at the cap, and a change that only moves the counterexample past the cap reads the same: rerun with a larger `--orders`, 400,000 or more, until the finding returns or no scenario is cut. Only then remove it from `FINDINGS` and from Findings.
2. If the change is intended and changes what a statement says or what a covered function does, update `statements.ts`, `steps.ts`, `server.ts`, `check.ts` or the copied text in `check.mjs` to match, and the coverage table above.
3. Apply each row of "Confirm the check can fail" again, and update a row whose code moved.
4. Move the sync commit forward only once you have confirmed that the model describes the code at the new commit.

CI runs the CI bounds through `extra-commands` in `.github/workflows/ci.yml`. Run `--full` by hand when a diff touches a covered file or this folder.
