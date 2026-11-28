# `antelopejs/no-inherited-key-lookup`

A plain object also answers the keys it inherits from `Object.prototype`, so a lookup with a caller's key such as `constructor` or `toString` returns a function where the code expects nothing.

## What it flags

- `table[key]`, `table[key] += 1` or `const { [key]: value } = table` with a computed key, where the same file declares `table` as a string-keyed object: `Record<string, V>`, `Record<PropertyKey, V>`, a string index signature, `Readonly` or `Partial` of one, a union of one with `undefined` or `null`, a class field read as `this.field[key]`, or a record property of a parameter whose type the file declares (`config.storages[name]`).
- A module-level `const` object literal, `as const` included, read with a parameter whose declared type can hold any string: `string`, `PropertyKey`, `keyof any`, a template literal, or a type parameter with no constraint or constrained to `string`. A key narrowed by a type predicate still counts as open.
- `key in obj` with a non-literal key, whatever the type of `obj`, unless `key` is the parameter the enclosing type predicate narrows.

These pass:

- Literal keys, `typeof x` keys, and keys held in a `const` of the same file.
- Keys from `Object.keys(table)`, `Object.entries(table)`, `for...in` over the same table, or an array of string literals, through `filter`, `sort` and `map` too.
- A read guarded by `Object.hasOwn(table, key)` or `hasOwnProperty.call(table, key)`.
- A table built with a null prototype: `Object.create(null)` or `{ __proto__: null, ... }`.
- A `Map`, an array read by index, a table keyed by a closed union (`Record<Status, V>`), and a module-level `const` object read with a parameter typed by a union of string literals, `keyof typeof table`, an enum or a number.
- Writes, `delete`, `#name in obj` and `Symbol.iterator in obj`.
- A table imported from another file.

## Fix

Store the table in a `Map` and call `.get(key)` and `.has(key)`. When the table must stay a plain object, check `Object.hasOwn(table, key)` before the read, or build it with `Object.create(null)` or `{ __proto__: null, ... }`. Replace `key in obj` with `Object.hasOwn(obj, key)`. When only a known set of keys is valid, type the key parameter with that union, for example `keyof typeof TABLE`.

## Example

```ts flagged fragment [src/summary.ts]
type Builder = (path: string) => string;

const BUILDERS: Record<string, Builder> = {
  read_file: (path) => `Read ${path}`,
};

export function summary(tool: string, path: string): string {
  const builder = BUILDERS[tool];
  return builder ? builder(path) : tool;
}
```

```ts fixed fragment [src/summary.ts]
type Builder = (path: string) => string;

const BUILDERS = new Map<string, Builder>([
  ["read_file", (path) => `Read ${path}`],
]);

export function summary(tool: string, path: string): string {
  return BUILDERS.get(tool)?.(path) ?? tool;
}
```
