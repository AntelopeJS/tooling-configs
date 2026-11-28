# `antelopejs/no-interface-instanceof`

`instanceof` is false for a value built by another copy of the package that declares the class, and two AntelopeJS modules can each load their own copy of an interface package.

## What it flags

- `value instanceof C`, where `C` is imported from an `@antelopejs/interface-*` package: a named import, a renamed import, or a member of a namespace import (`value instanceof core.AsyncProxy`).
- Inside an `@antelopejs/interface-*` package, `value instanceof C`, where `C` is a class the same file exports in its declaration, through an export list or as the default export.

These pass:

- Classes from other packages, from relative imports, and classes the file declares without exporting them.
- A parameter or local binding that shadows the imported class.
- `import type` bindings, which have no runtime value.

## Fix

Call the brand guard the interface package exports next to the class, such as `IsStream`, `IsDatum` or `IsQuery` from `@antelopejs/interface-database`. A brand guard checks a `Symbol.for(...)` marker the class sets, so it holds for every copy of the package. When the package has no guard for the class, add one next to the class in the interface package: a property keyed by a `Symbol.for` brand and an `IsName(value: unknown): value is Name` function that checks it.

## Example

```ts flagged fragment [src/describe.ts]
import { Stream } from "@antelopejs/interface-database";

export function describe(query: unknown): string {
  return query instanceof Stream ? "stream" : "single value";
}
```

```ts fixed fragment [src/describe.ts]
import { IsStream } from "@antelopejs/interface-database";

export function describe(query: unknown): string {
  return IsStream(query) ? "stream" : "single value";
}
```
