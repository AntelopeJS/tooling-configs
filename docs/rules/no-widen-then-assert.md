# `anti-slop/no-widen-then-assert`

Widening a value whose type is known and asserting it back later throws the compiler's evidence away and replaces it with an unchecked claim.

## What it flags

A type assertion (`x as T` or `<T>x`) to a narrower type on a local `const` binding that was widened from a value of known type, in the same function:

- The binding is annotated or asserted as `unknown`, `any`, `object`, or a record of `unknown` or `any` values such as `Record<string, unknown>`, `{ [key: string]: any }` or their `Readonly` form.
- Its initializer has a known type: a literal, an object or array literal, a function, a `new` expression, an assertion to a precise type, a variable annotated with a precise type in the same function, or a `const` chain of these.

For `object` the assertion must name an object type, and for a record type it must name a type with named members or concrete values.

These pass:

- A binding whose value comes from a call or a parameter, such as `const raw: unknown = JSON.parse(text)`.
- A `let` binding.
- An assertion in another function than the widening.
- An assertion to another broad type.

## Fix

Keep the precise type from the initialization to the use: drop the widening annotation or assertion. When a call needs the broad type, pass the value to it and keep using the precise binding. When the value comes from outside, parse it once at the boundary into its domain type.

## Example

```ts flagged fragment [src/settings.ts]
export interface Settings {
  readonly theme: "dark" | "light";
  readonly pageSize: number;
}

export function defaultSettings(): Settings {
  const settings: unknown = { theme: "dark", pageSize: 20 };
  // SAFETY: settings is the object literal above.
  return settings as Settings;
}
```

```ts fixed fragment [src/settings.ts]
export interface Settings {
  readonly theme: "dark" | "light";
  readonly pageSize: number;
}

export function defaultSettings(): Settings {
  const settings: Settings = { theme: "dark", pageSize: 20 };
  return settings;
}
```
