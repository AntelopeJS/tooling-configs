# `antelopejs/no-presence-only-type-guard`

A type guard that checks only that a key exists passes a value whose member holds anything, and every caller then trusts a type the value does not have.

## What it flags

In a type predicate (`value is T`) or an assertion function (`asserts value is T`):

- `key in table`, where `key` is the narrowed parameter: it is also true for keys inherited from `Object.prototype`, such as `constructor`.
- `"k" in value`, `Object.hasOwn(value, "k")`, `hasOwnProperty.call(value, "k")` or `Reflect.has(value, "k")` when the guard never reads `value.k`.
- When the parameter is typed `unknown`, `object`, `{}` or `Record<string, unknown>`: each member of the narrowed type, declared in the same file, that the guard never reads.

These pass:

- A member typed `unknown` or `any`, which needs only its presence.
- A parameter typed by a union of object types, where `"meow" in pet` picks a member of the union.
- A key typed `` `prefix${string}` `` when no `Object.prototype` member starts with that prefix.
- A read through an alias (`const record = value`), a cast (`(value as T).k`), a destructuring, or a call to another guard or helper that receives the parameter and the key.
- A narrowed type the file does not declare, such as one imported from another file.

## Fix

Check each member's value, not only its presence: `typeof value.k === "number"`, `Array.isArray(value.k)`, or a nested guard. For a key guard, use `Object.hasOwn(table, key)`, or keep the keys in a `Map` or `Set` and call `.has(key)`. When the guard checks only some members, narrow to a type that declares only those (`Pick<T, "k">`). For a large shape, parse the value with a schema.

## Example

```ts flagged fragment [src/handshake.ts]
interface Handshake {
  pid: number;
  secret: string;
}

export function isHandshake(value: unknown): value is Handshake {
  return (
    typeof value === "object" &&
    value !== null &&
    "pid" in value &&
    "secret" in value
  );
}
```

```ts fixed fragment [src/handshake.ts]
interface Handshake {
  pid: number;
  secret: string;
}

export function isHandshake(value: unknown): value is Handshake {
  return (
    typeof value === "object" &&
    value !== null &&
    "pid" in value &&
    typeof value.pid === "number" &&
    "secret" in value &&
    typeof value.secret === "string"
  );
}
```
