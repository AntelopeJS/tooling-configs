# `anti-slop/no-reflect-get`

`Reflect.get` returns `any` for any key, so a typo or a missing property reaches the caller as a value of the wrong type.

## What it flags

- A call to the global `Reflect.get` or `Reflect["get"]`.

These pass:

- Property access, `owner.key` or `owner[key]`.
- `Reflect.set` and the other `Reflect` methods.
- A local variable or parameter named `Reflect`.

## Fix

- A known key: read it with property access, `settings.theme`.
- A key chosen at run time: type the key as `keyof` the owner type and read `owner[key]`.
- A value from outside the program: decode it into a named type where it enters, then read its properties.

## Example

```ts flagged fragment [src/settings.ts]
export interface Settings {
  readonly theme: string;
}

export function themeOf(settings: Settings): string {
  return Reflect.get(settings, "theme");
}
```

```ts fixed fragment [src/settings.ts]
export interface Settings {
  readonly theme: string;
}

export function themeOf(settings: Settings): string {
  return settings.theme;
}
```
