---
name: formal-json-value-identity
description: Generated-input check that distinct, group, eq, a hashed join and orderBy of @antelopejs/mysql treat JSON values another writer spelled as MySQL's JSON comparison does, on MySQL 8.4 and 9.7 and MariaDB 11.8 and 12.3 (number spellings at the int64, uint64 and double edges, -0, exponents, decimals of other scales, absent, null and "null", long strings that share a prefix, containers nested to 24 levels). Use when a change touches how a JSON value is deduplicated, grouped, compared, joined on or sorted, such as the number normalisation in src/dialect/mysql/sql-json.ts, flavour.ts and src/dialect/mariadb/numbers.ts, or needs proof that one JSON value is never read as two or two as one.
---

# Formal check: the identity of a JSON value

A field of no declared type holds a JSON value that another writer of the table spelled: `1`, `1.0`, `1e0` and `10e-1` are one number, `-0` and `0` are one number, `9007199254740993` and `9007199254740992e0` are two. MySQL compares such values by value. MariaDB keeps the text as written, so the module rebuilds MySQL's comparison there. `docs/behaviour.md` states the promise this check guards: `distinct`, `group`, `eq` and a join's condition find two values the same exactly where MySQL's JSON `=` does, and `orderBy` sorts mixed kinds in MySQL's JSON order.

**The property.** For a generated set of rows, each holding one or two JSON values written in any spelling, `group("v")` partitions the rows, `group("g", (s) => s.distinct("v"))` counts the values, `eq` between two keys of a row and a join on `eq` find the pairs, and `orderBy("v")` ascending and descending never puts a pair the wrong way round, all as the reference model in `src/test/json-model.ts` says MySQL's JSON comparison does.

**The harm.** One value read as two, or two as one, depending on how its writer spelled it: a `group()` that splits a customer's rows into two buckets, a dedup that keeps both `1` and `1.0`, a join that misses a match. Nothing fails; every read answers.

## Run it

From the repository root, with Docker running:

```sh
node .agents/skills/formal-json-value-identity/check.mjs          # 300 scenarios
node .agents/skills/formal-json-value-identity/check.mjs --full   # 2000 scenarios
```

`--runs <n>` and `--seed <n>` override the bounds and the seed. The check builds the module, then runs `src/test/formal-json-value-identity.test.ts` with `ajs module test`, against the server in `MYSQL_TEST_URL` or else a container of `MYSQL_TEST_IMAGE` (default `mysql:8.4`). It prints nothing when the property holds. It exits 1 and prints `BROKEN JsonValueIdentity`, the seed, the fewest rows that still disagree and what each side read; it exits 2 when it could not run. `pnpm test` runs the same file on all four images.

| Bounds                      | Scenarios | Rows per scenario | Wall time on one engine       |
| --------------------------- | --------- | ----------------- | ----------------------------- |
| `pnpm test` and the default | 300       | 2 to 8            | 1 s on MySQL, 3 s on MariaDB  |
| `--full`                    | 2000      | 2 to 8            | 6 s on MySQL, 20 s on MariaDB |

A scenario draws a pool of one to five values, then each row spells two of them with its own seed, so the same value is written several ways in one table. fast-check does not typecheck under this repository's `tsconfig` (`pure-rand`'s types need `nodenext`), so `src/test/json-spell.ts` holds a seeded generator, and the check shrinks a failure by dropping rows.

## What the check holds to

| Read                                 | Holds when                                                                                                                                              |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `group("v")`                         | The rows of one part are exactly the rows whose values `ClassOf` puts in one class                                                                      |
| `group("g", (s) => s.distinct("v"))` | Each group keeps one value per class, an absent key and a JSON null apart                                                                               |
| `eq` between two keys                | The rows listed are exactly those whose two values are present and equal                                                                                |
| `joinInner` on `eq`                  | The pairs are exactly the pairs of present, equal values                                                                                                |
| `orderBy("v")`, both directions      | No pair is put the wrong way round by absent, null, numbers, strings, objects, arrays, false, true; objects and arrays are not compared with each other |

`src/test/json-model.ts` is the reference model. A number is an integer of 64 bits compared exactly, or a double; an integral double compares by the digits of its shortest decimal, as `src/test/equal-numbers.test.ts` records for every engine.

## Findings

Each finding is excluded from the main property and pinned by a test under "known findings" that asserts the wrong answer, so a fix makes the pin fail and tells the next agent to delete the pin and the exclusion.

- **`group()` splits equal arrays on MySQL.** `group("v")` over `[9223372036854775808e0]`, `[9223372036854775808]` and `[9223372036854775808E+0]` reads three groups on MySQL 8.4 and 9.7, where JSON `=` finds the first and last equal. MySQL's native `GROUP BY` of an array that holds a number past 2^53 does not keep equal doubles together once an integer sits between them in its sort. `SELECT GROUP_CONCAT(id) FROM t GROUP BY v` over those three rows of a `JSON` column answers `0`, `1`, `2`. The module normalises a number at the top level of the value and not inside a container. The main property skips the `group` read on MySQL for a scenario whose values hold such a number.
- **`orderBy()` ignores the value past 2^53 on MariaDB.** On MariaDB 11.8 and 12.3 the integer `9007199254740993` sorts before the double `9007199254740992e0`, where MySQL sorts it after: the order compares the number as a double, then the text. The main property leaves out a pair of two numbers past 2^53 on MariaDB.

## Scope and assumptions

| Covers                                                                                                                              | What it holds to                                                  |
| ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `src/dialect/mysql/sql-json.ts`, `sql-json-kinds.ts`, `flavour.ts`, `src/dialect/mariadb/numbers.ts`, `json-text.ts`                | the SQL that reads one value in one spelling                      |
| `src/implementations/database/stages-aggregate.ts`, `stages-group.ts`, `grouped.ts`, `join-key.ts`, `value-key.ts`, `ranked-key.ts` | the dedup, the group, the join key and the sort key built from it |

Sync commit: `0328962`. Move it forward only after you confirm the check still describes the covered code at the new commit.

- Only MySQL 8.4 and 9.7 and MariaDB 11.8 and 12.3 are run, one at a time.
- MySQL's own parser reads a significand of more than 15 digits scaled past 10^22 as a double one step from the nearest, which MariaDB does not. The generator writes only spellings both parse alike (`ParsesExactly` in `src/test/json-spell.ts`), so that a parser limit is never read as the module's. Numbers beyond the doubles, which MariaDB stores as written and MySQL refuses, are out of scope; `equal-numbers.test.ts` covers them.
- MariaDB keeps a document as written, and `docs/mariadb.md` says a dedup compares its text there. So on MariaDB the check writes strings and keys without `\uXXXX` escapes and an object's keys in MySQL's order; a spelling that varies the escapes or the key order of one value is a documented MariaDB limit and not drawn.
- An object or an array is compared for equality only; their order is undefined by contract.
- No declared field, index or computed key is read: `v` and `w` are undeclared.

## Confirm the check can fail

| Scratch change                                                                                                      | Result                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Run the file at `1c7db9b`, the parent of the fix that merges `0` and `-0` (#39), with this folder's files copied in | MySQL 8.4: `distinct: read [0,2], MySQL's comparison gives [0,1]` for `-50343` against `-50343.0`. MariaDB 11.8: `group: read ["2","3"], MySQL's comparison gives ["2,3"]` |
| In `Deduplicable` of `stages-aggregate.ts`, return a JSON value as it is                                            | MariaDB 11.8: fails on seed 20261118                                                                                                                                       |

Drop each change and confirm the check is back to exit 0.
