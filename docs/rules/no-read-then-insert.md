# `antelopejs/no-read-then-insert`

Two replicas that start on an empty table both read nothing and both insert, so one writes a duplicate row or fails on the key.

## What it flags

- A call to `insert`, `insertOne` or `insertMany` on a table that an earlier `get`, `getAll`, `count`, `find`, `findOne`, `getBy…` or `findBy…` call read in the same function.
- An insert, on any table, in a function of the same file that runs only when an awaited read found nothing: the call sits in the branch an `if`, `?:`, `&&` or `||` takes on the empty result. The read is awaited directly, through `.run()` or through `.then`, so `Map.get` and `headers.get` do not count.
- An insert of an object literal whose `_id` is a name or a member, such as `_id: tenantId` or `_id: request.tenantId`, wherever the read that decides it sits. Another writer of the same key can win the race.

These pass:

- An upsert: `insert(row, { conflict: "update" })`.
- An `_id` bound once to `randomUUID()` and never reassigned.
- An insert inside a `try` whose `catch` tolerates the lost race: it rethrows nothing, rethrows only when a condition does not recognise a duplicate-key error, or reads the row back and rethrows only when the row is still missing. A `.catch(...)` handler that does the same also passes.
- An insert handed to a helper that also receives the table, such as `insertRowOnce(model, id, () => model.insert(row))`.
- A read and an insert on different tables, an insert before the read, and route handlers that one function registers side by side.

## Fix

Key the row by a stable id, so every replica writes the same key. Then pick one shape:

- Upsert: `insert(row, { conflict: "update" })`.
- Wrap the insert in `try`/`catch`, read the row back in the `catch`, and rethrow only when it is still missing.
- Wrap the insert in `try`/`catch` and rethrow only when the error is not a duplicate-key error.

## Example

```ts fragment [src/settings-table.ts]
export interface Settings {
  _id: string;
  locale: string;
}

export interface SettingsTable {
  get(id: string): Promise<Settings | undefined>;
  insert(rows: Settings[]): Promise<void>;
}
```

```ts flagged fragment [src/settings.ts]
import type { SettingsTable } from "./settings-table.ts";

export async function ensureSettings(table: SettingsTable): Promise<void> {
  if (await table.get("settings")) return;
  await table.insert([{ _id: "settings", locale: "en" }]);
}
```

```ts fixed fragment [src/settings.ts]
import type { SettingsTable } from "./settings-table.ts";

export async function ensureSettings(table: SettingsTable): Promise<void> {
  if (await table.get("settings")) return;
  try {
    await table.insert([{ _id: "settings", locale: "en" }]);
  } catch (error) {
    if (!(await table.get("settings"))) throw error;
  }
}
```
