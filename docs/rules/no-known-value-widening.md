# `anti-slop/no-known-value-widening`

An explicit broad type on a value whose shape is known at the site throws away the keys and types the compiler had, so every later read has to narrow again or guess.

## What it flags

A known value flowing into an explicit broad type. A known value is an object or array literal, a function, a class, a `new` expression, a literal, a template, or a `const` bound to one of them. A broad type is one of:

- `unknown` or `object`;
- an open dictionary: `Record<string, T>`, `Record<PropertyKey, T>`, an index signature `{ [key: string]: T }`, a mapped type over `string`, or a local alias or generic alias that resolves to one;
- an anonymous object type written inline, such as `{ start: Command }`.

The rule reads the type on a variable, a class property, an assignment to an annotated variable, a function's return type, and an `as` or angle-bracket assertion. It also flags a call to a local type guard whose parameter is `unknown` when the argument is a known value or has a declared type, such as `isString("known")` or `isString(name)` with `name: string`.

These pass:

- No annotation, `as const`, and `satisfies`.
- A named interface or type alias with fixed members, and any imported type.
- `Record<K, T>` over a finite key union, such as `Record<"vegan" | "omnivore", string>`.
- An empty `{}` into an open dictionary, which starts an accumulator.
- A value the rule cannot see, such as the result of a declared function.

## Fix

- Drop the annotation and let the compiler infer the type.
- To check the value against a contract and keep its precise type, use `satisfies`: `{ start } satisfies Record<string, Command>`.
- When callers need the type, name it: an interface or type alias with fixed members.
- When a type guard receives a value already known at the call, use the value directly and call the guard only on unparsed input.

## Example

```ts flagged fragment [src/commands.ts]
type Command = () => void;

const start: Command = () => {};

export const commands: Record<string, Command> = { start };
```

```ts fixed fragment [src/commands.ts]
type Command = () => void;

const start: Command = () => {};

export const commands = { start } satisfies Record<string, Command>;
```
