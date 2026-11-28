# `anti-slop/no-runtime-typeof`

A `typeof` check in ordinary code narrows how a value is stored without deciding what it means, so the same unparsed value gets checked again in every function that reads it.

## What it flags

- A `typeof` expression, such as `typeof input === "string"`.
- A `typeof` that fills in the text of a message, such as ``throw new Error(`received ${typeof value}`)``, because a caller may catch and compare that text.
- `value.constructor === String`, and the same with `Number`, `Boolean`, `BigInt`, `Symbol` or `Function`.
- `value instanceof Function` and `value instanceof Object`.
- A `typeof` in a callback inside a type guard, such as `value.every((item) => typeof item === "string")`: the callback is the nearest function, and it is not a guard.

These pass:

- An existence probe compared with `"undefined"`, such as `typeof document === "undefined"`.
- Any of these checks inside a function that returns a type predicate (`value is T`) or an assertion (`asserts value is T`). In `.js`, `.mjs` and `.cjs` files, a JSDoc `@returns {value is T}` that names a parameter counts too.
- `instanceof` with any other class, such as `Error` or `Array`.
- `typeof` in a type, such as `type Config = typeof config`.

## Fix

- Move the check into a type guard, `(value: unknown): value is T`, or an assertion function, and call it where the value enters the program. After that, branch on the decoded value.
- For a callback inside a guard, extract the check into its own guard and pass it: `value.every(isString)`.
- For a message, state what the code expected and leave out the runtime type: `"PORT must be a positive integer."`.

## Example

```ts flagged fragment [src/port.ts]
export function readPort(text: string): number {
  const value: unknown = JSON.parse(text);
  if (typeof value !== "number") throw new Error(`PORT is a ${typeof value}.`);
  return value;
}
```

```ts fixed fragment [src/port.ts]
function isPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

export function readPort(text: string): number {
  const value: unknown = JSON.parse(text);
  if (!isPort(value)) throw new Error("PORT must be a positive integer.");
  return value;
}
```
