# `anti-slop/no-unsafe-dictionary-type`

A dictionary whose values are `unknown`, `any`, `object` or `{}` accepts any value and promises its readers nothing, so every read needs its own unchecked cast.

## What it flags

A `Record<K, V>`, an index signature `{ [key: string]: V }` in a type literal or interface, or a mapped type `{ [K in P]: V }`, where the value type `V` is:

- `unknown`, `any`, `object` or `{}`.
- An empty interface, or a type with no member except an optional `never` brand.
- A union that contains one of these, an intersection of only these, such as `unknown & {}`, or an intersection with `any`.
- `Readonly`, `Partial`, `Required` or `NonNullable` of one of these, or an alias in the same file that resolves to one.

Wrapping the dictionary in `Readonly`, `Pick` or `Omit` does not hide it. A variable or parameter typed with an alias of an unsafe dictionary is not reported again; the alias is.

These pass:

- A concrete value type, such as `Record<string, Command>` or `Record<Permission, number>`.
- `unknown` nested deeper in the value, such as `Record<string, { payload: unknown }>`.
- `Map`, `ReadonlyMap` and `WeakMap`.
- A type parameter constraint, such as `<T extends Record<string, unknown>>`.
- Exactly `Record<string, unknown>` as the target of a `value is T` predicate, or written inside the body of a type guard.

## Fix

Give the values a type: the owner's type, a type derived from the schema that parses the payload, or a union of the values the dictionary holds. Parse external payloads before they go in.

- A function that takes any object: make it generic, `<T extends Record<string, unknown>>(input: T)`.
- Code that reads keys off an unknown value: do it inside a type guard that returns the parsed type.

## Example

```ts flagged fragment [src/flags.ts]
export type FlagName = "betaSearch" | "darkMode";

export type FeatureFlags = Record<FlagName, unknown>;

export function isEnabled(flags: FeatureFlags, name: FlagName): boolean {
  return flags[name] === true;
}
```

```ts fixed fragment [src/flags.ts]
export type FlagName = "betaSearch" | "darkMode";

export type FeatureFlags = Record<FlagName, boolean>;

export function isEnabled(flags: FeatureFlags, name: FlagName): boolean {
  return flags[name];
}
```
