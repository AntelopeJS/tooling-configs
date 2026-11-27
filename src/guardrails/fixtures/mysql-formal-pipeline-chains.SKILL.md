---
name: formal-pipeline-chains
description: Property check, with fast-check against a live server, that every engine answers a drawn chain of stages (filter, map and merge, orderBy, slice, nth, group, lookup, union, pluck, without, a nested query on the outer row) and the events of a change feed over such a chain as an in-memory reference evaluator does, row for row and in order (the stage compiler in src/implementations/database/ stage*.ts, render.ts, wrap.ts, grouped.ts, relation.ts, subquery.ts, context.ts and feed-pipeline.ts, and the SQL of src/dialect/). Use when a change touches any of those files, or needs proof that a chain of stages answers the same on MySQL 8.4, MySQL 9.7, MariaDB 11.8 and MariaDB 12.3.
---

# Formal check: pipeline chains

A query is a chain of stages. The module compiles each chain into one statement, and each engine reads that statement its own way. A stage that wraps the rows before it in a derived table, a nested query that reads its outer row, a group or a second map can lose the order of the rows, fail with an unknown column or answer another row's value, on one engine only.

**The property.** Over the documents of `seed.ts`, the module's answer to a drawn chain equals the answer of the reference evaluator in `model.ts`: the same rows, in the same order wherever the chain's order is defined, or the same rows in any order where it is not. A chain over `changes()` delivers the events the evaluator expects, in commit order, with the old and the new image the chain's stages make of the row.

**The harm.** A wrong answer is a wrong table in a consumer's page, a count that does not add up or a mirror built from a feed that carries `newValue` null. Nothing fails: the statement ran.

## What the check runs

The properties run the real module, so they need a server. `check.mjs` builds the module, compiles this folder into `dist/formal-pipeline-chains`, and runs each property file through `ajs module test`. `scripts/test.sh` runs it as the `chains` suite on every image of `pnpm test`.

| File                            | Property               | What it draws                                                                                                                                        |
| ------------------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pipeline-chains.test.ts`       | `ChainsMatchReference` | 0 to 6 stages and a terminal (rows, `count`, `nth`), alone on `items` or for each owner of `owners.map(...)`, where a stage may read the outer owner |
| `pipeline-chains-feeds.test.ts` | `FeedsMatchReference`  | 0 to 5 stages before `changes()`, then 1 to 5 writes of one row each: an insert, an update or a delete                                               |

- `draw.ts` draws a stage only where it keeps the answer defined. Each draw is a list of numbers that `Resolve` turns into stages by what the chain holds so far: its fields, the fields no two rows share and whether its order is defined. A `slice`, an `nth` or a feed's order of rows is never drawn over rows in no defined order, since two engines could both be right.
- `model.ts` is the reference: `Evaluate` runs the stages over `Doc`s in memory, and `Delivered` turns a script of writes into the events of a feed. It follows `docs/behaviour.md` (an ascending sort puts an absent value first, `ne` keeps a row that lacks the field, successive `orderBy` stages are stable, `group` and `union` keep no order) and `docs/change-feeds.md` (an event is delivered when either image passes the filter, and both images go through the maps).
- `build.ts` writes the same stages as module calls.
- Each run draws from the fixed seed `CHAINS_SEED` (20261116), so a failure repeats. fast-check shrinks a chain that fails. A feed script that fails is not shrunk, since each case takes seconds.

The seed tables hold ten items, three extra items for `union`, and five owners. `n` takes 0 to 3, `kind` takes `a`, `b`, `c` or is missing, `ownerId` names an owner, a missing owner or nothing, and `refs` lists owners, some missing.

## Run it

From the repository root, with `pnpm install` done and Docker running:

```sh
node .agents/skills/formal-pipeline-chains/check.mjs          # CI bounds
node .agents/skills/formal-pipeline-chains/check.mjs --full   # full bounds
```

It runs against `MYSQL_TEST_URL` or else a `MYSQL_TEST_IMAGE` container (`mysql:8.4` by default), and prints nothing when both properties hold. `--runs <n>` and `--seed <n>` override the bounds, `--no-build` skips the build of the module.

| Bounds          | `ChainsMatchReference` | `FeedsMatchReference` | Wall time on MySQL 8.4 |
| --------------- | ---------------------- | --------------------- | ---------------------- |
| CI (default)    | 1,000 chains           | 30 scripts            | about 1 min            |
| Full (`--full`) | 10,000 chains          | 150 scripts           | 2 min 30 s             |

`CHAINS_RUNS` and `FEEDS_RUNS` set the bounds without the script.

- Exit 0: both properties hold.
- Exit 1: `BROKEN <property>`, then the counterexample.
- Exit 2: the check could not run: the build failed or no server answered.

## Read a result

The failure message holds three JSON documents: `chain` (or `stages` and `writes` for a feed), `expected` and `answer` (or `events`), or the error the server answered.

1. Find the first stage where the two answers part. Drop the stages after it: the failure stays with fewer stages.
2. Check the reference against the docs, not against the other engine. When the docs and the evaluator disagree, the evaluator is wrong: fix `model.ts` and run again.
3. Otherwise the module answers wrong. Run the chain by hand on each engine: an error such as `Unknown column 't0.take' in 'WHERE'` names an engine whose compiler cannot read the outer row, and a wrong row names a stage that read another row's value.
4. Do not weaken the property or draw around the chain to pass. A defect that stays gets an `ExpectedFailure` test (see Findings) with its reproduction, and the chain stays out of the draw only as long as the defect lasts.

## Findings

Found on `next` at the sync commit, none fixed here:

| Defect                                                                                                                                                                                                                                                       | Engine       | What the property does about it                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pluck` drops a member that holds a JSON null: `map((row) => ({ k: row.key("kind") })).pluck("k")` answers `{}` for a row without a kind, where `group("kind", ...).without("c")` answers `{ k: null }`                                                      | all          | `ExpectedFailure` in `pipeline-chains.test.ts`. `draw.ts` keeps `pluck` off a field that can hold a null (`nullable`).                                                                                                                                                                                |
| `nth` of an ordered chain that merges and filters on the outer owner answers `null` for every owner but the first: `owners.map((o) => items.orderBy("slug").map(merge).filter(n eq o.take).nth(0))`                                                          | MariaDB 11.8 | `ExpectedFailure`. `draw.ts` draws no `nth` after a `merge` and a `filterOuter` in a nested chain.                                                                                                                                                                                                    |
| `mariadbd` ends with signal 11 (in `JOIN::exec_inner`) on module statements that mix a `lookup` or a `lookupList` with a `merge` in one chain, after a few hundred chains of a run; the statements are the ones with `JSON_MERGE_PRESERVE` over `JSON_TABLE` | MariaDB 11.8 | None. A crash ends the server, so no test can hold it. `draw.ts` offers no `merge` after a `lookup` and no `lookup` after a `merge`. Remove the two conditions in `Offered` to see it: the run ends with `Connection lost: The server closed the connection`, at chain 36 to 600 for the seeds tried. |

Each `ExpectedFailure` passes while its reproduction fails and fails once the module answers right: delete it and the matching exclusion in `draw.ts` then.

## Scope and assumptions

Covered, at the sync commit:

| Stage or form                      | Drawn                                                                                                                                                                                                                                                                   |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `filter`                           | `eq`, `ne`, `gt`, `lt` on a number, a text or a field some rows lack, and on the outer owner's `take`                                                                                                                                                                   |
| `map` with `merge`                 | a constant, a number field plus or times a constant, the number of members the merged row has, a nested query on the outer row (the owners with a `take` equal to a field, the label of the first owner whose `take` reaches it), the outer owner's `take` plus a field |
| `orderBy`, `slice`, `nth`, `count` | any field, both directions, a constant or an outer index and bound                                                                                                                                                                                                      |
| `group`                            | by a number or a text field, with a count, a sum, and the sum over the outer owner                                                                                                                                                                                      |
| `lookup`                           | `ownerId` to the owner, a missing owner answers `null`; `refs` to the owners it names, in the order of an ordered query                                                                                                                                                 |
| `union`                            | the chain so far, applied again to `extras`                                                                                                                                                                                                                             |
| `pluck`, `without`                 | any subset of the fields                                                                                                                                                                                                                                                |
| `changes()`                        | `filter`, `merge` with a constant or a number field, `pluck`, `without`, `lookup`, over writes of one row each, and the update that leaves and enters a filter before two merges, written out in `pipeline-chains-feeds.test.ts`                                        |

Left out:

- `distinct`, `join`, `joinInner`, `getAll`, `between`, `avg`, `min`, `max`, and the array and date stages of a value: `value-stages-*.test.ts` and `src/test/unit/` cover them.
- A group callback that holds a nested query, and a group inside a group callback. The module compiles them into one statement, and on MariaDB refuses the three reads of a group's stream `docs/behaviour.md` lists. The check draws only a nested group that sums a field, or the field plus the outer `take`: `outer-row-group-reads.test.ts`, `outer-row-group-distinct.test.ts` and `outer-row-join.test.ts` enumerate the rest.
- Concurrent writers and a quiet table between writes: `formal-change-feed-delivery` covers delivery order, and this check writes one row at a time.
- Rows that hold nested objects, dates and numbers past 2^53.
- `CROSS_INSTANCE` reads and external instances.
- A stage whose answer the docs leave open: the order of rows after `group`, `union` or `distinct`.

## Confirm the check can fail

Each row ran the properties of this folder against the code of the commit before the fix, with 5,000 chains and 60 scripts of the seed above (1,500 scripts for #78), on the server named. The folder was copied over a scratch worktree of that commit. The first failure of each run:

| Fix | Commit before the fix | Server       | First failure                                                                                                                                                                               |
| --- | --------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #4  | `d8842a8`             | MariaDB 11.8 | chain 21: `without("_id").orderBy("slug", "desc").pluck("slug")` answers the slugs ascending. `check.mjs` exits 1 and prints `BROKEN ChainsMatchReference` and `BROKEN FeedsMatchReference` |
| #9  | `c13e624`             | MariaDB 11.8 | chain 29: for each owner, `orderBy("_id").lookupList` answers other rows than the reference                                                                                                 |
| #75 | `05b3c53`             | MariaDB 11.8 | script 5: no event arrives, because the poll fails with `Unknown column 'ev.new_row' in 'JSON_TABLE'` and retries                                                                           |
| #78 | `43bbac5`             | MariaDB 11.8 | the written-out update: the feed delivers `newValue: [null]` and `oldValue: [null]` for the update that leaves the filter. The drawn scripts did not reach this in 1,500                    |
| #60 | `79585b4`             | MySQL 8.4    | chain 9: `Unknown column 't2.l' in 'field list'`                                                                                                                                            |
| #68 | `0a4fc37`             | MySQL 8.4    | chain 9: `Unknown column 't2.l' in 'field list'`                                                                                                                                            |

This check has not shown the fixes of #7, #16, #28 and #86 alone: the commits before #7, #16 and #28 hold #60's defect as well, and the group shape that #86 fixed is outside what `draw.ts` draws. At the sync commit both properties hold on MySQL 8.4 and on MariaDB 11.8 under the full bounds.

## Keep it in step

Sync commit: `f8f2e05`. At that commit the evaluator, the draw and the covered files describe the same code.

When a change touches a covered file:

1. Run both bounds. A failure is a bug in the change until step 2 of "Read a result" shows the reference is wrong.
2. When a change adds a stage or alters what the docs promise, add it to `Stage` in `model.ts`, to `Evaluate`, to `build.ts` and to a resolver in `draw.ts`, then list it under Scope.
3. Run the properties against a scratch change that breaks the stage, and add a row to "Confirm the check can fail".
4. Move the sync commit forward only once you have confirmed that the reference describes the code at the new commit.

`scripts/test.sh` runs it as the `chains` suite against each server image. Run `--full` by hand when a diff touches a covered file or this folder.
