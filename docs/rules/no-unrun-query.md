# `antelopejs/no-unrun-query`

Since `@antelopejs/interface-database` 0.4.0 a query is not thenable, so a caller that awaits an unrun query receives the query object and nothing reaches the database.

## What it flags

With type-aware lint on, in a project that installs `@antelopejs/interface-database`, an unrun query that a caller awaits:

- Returned from an async function or arrow, or from a function handed to `then`, `catch` or `finally`, inline or by name: `async () => table.count()`, `.then(countRows)`.
- Passed to `resolve` in a `new Promise` executor, inline or by name: `resolve(table.count())`.
- Wrapped in `Promise.resolve`, or held at any depth in arrays, tuples, object literals and the interfaces and object types the project declares: `async () => ({ total: table.count() })`.

A query is a type whose `run()` the installed `@antelopejs/interface-database` declares.

These pass:

- A query that is run: `table.count().run()`.
- A query a plain, non-async function returns to its caller, which can still build on it.
- A held `Table`, such as `async () => ({ table })`: it is a handle, not a pending query. A class instance and an object with its own `run()` also pass.

## Fix

Call `.run()` where the function resolves the query: `return table.count().run()`, `resolve(table.count().run())`, `({ total: await table.count().run() })`. When the caller is meant to extend the query, drop `async` and return the query from a plain function.

## Example

```json [node_modules/@antelopejs/interface-database/package.json]
{ "name": "@antelopejs/interface-database", "types": "index.d.ts" }
```

```ts fragment [node_modules/@antelopejs/interface-database/index.d.ts]
export interface Datum<T> {
  run(): Promise<T>;
}

export interface Table<T> {
  count(): Datum<number>;
  insert(row: T): Datum<string[]>;
}
```

```ts flagged fragment [src/novels.ts]
import type { Table } from "@antelopejs/interface-database";

export async function countNovels(novels: Table<{ title: string }>) {
  return novels.count();
}
```

```ts fixed fragment [src/novels.ts]
import type { Table } from "@antelopejs/interface-database";

export async function countNovels(novels: Table<{ title: string }>) {
  return novels.count().run();
}
```
