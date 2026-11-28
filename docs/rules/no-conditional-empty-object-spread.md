# `anti-slop/no-conditional-empty-object-spread`

A spread of `cond ? { key } : {}` hides which properties an object can lack inside an expression, so a reader has to evaluate the spread to know its shape.

## What it flags

- A spread in an object literal whose argument is a conditional with `{}` in either branch, such as `{ ...(limit !== undefined ? { limit } : {}) }` or `{ ...(empty ? {} : { items }) }`.

These pass:

- A spread of a plain value, such as `{ ...defaults }`.
- A conditional that returns a whole object, such as `cond ? { value } : {}`, outside a spread.
- A spread inside an array, such as `[...(cond ? items : [])]`.

The rule has no autofix: an automatic rewrite could change which keys the object holds.

## Fix

- Create the object in one statement, then add each optional property in an `if` that checks it is present.
- When the whole object depends on one condition, return a different object literal from each branch: `limit === undefined ? {} : { limit }`.

## Example

```ts flagged fragment [src/query.ts]
export interface Query {
  readonly table: string;
  readonly limit?: number;
}

export function buildQuery(table: string, limit: number | undefined): Query {
  return { table, ...(limit !== undefined ? { limit } : {}) };
}
```

```ts fixed fragment [src/query.ts]
export interface Query {
  table: string;
  limit?: number;
}

export function buildQuery(table: string, limit: number | undefined): Query {
  const query: Query = { table };
  if (limit !== undefined) query.limit = limit;
  return query;
}
```
