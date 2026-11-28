# `anti-slop/no-object-parameters`

A parameter typed `object` accepts any non-primitive and tells the body nothing about its keys, so the body reads it through casts or `in` checks the caller never sees.

## What it flags

- A parameter annotated `object`, or a union that contains `object`, such as `object | null`.
- A parameter whose type is a local alias that resolves to `object`, also through a generic alias such as `Identity<object>`.
- Destructured parameters and parameters with a default value.

The rule checks functions, arrow functions, methods, declared functions, function types, and call, construct and method signatures.

These pass:

- A named interface or type alias with members, and any imported type.
- A type parameter, also one constrained by `object`: `function keys<T extends object>(value: T)`.
- `object` outside a parameter, such as a return type or a variable.

## Fix

- When the function reads known keys, accept an interface or type alias that names them.
- When the function works on any object and returns its type, take a type parameter: `<T extends object>(value: T)`.
- When the value comes from outside the program, decode it into a named type where it enters, and pass the decoded value.

## Example

```ts flagged fragment [src/settings.ts]
export function describeSettings(settings: object): string {
  return JSON.stringify(settings);
}
```

```ts fixed fragment [src/settings.ts]
export interface Settings {
  readonly theme: string;
  readonly locale: string;
}

export function describeSettings(settings: Settings): string {
  return `${settings.theme} (${settings.locale})`;
}
```
