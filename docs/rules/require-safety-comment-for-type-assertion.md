# `anti-slop/require-safety-comment-for-type-assertion`

A type assertion or a non-null assertion makes the compiler trust a fact it cannot check, and without the reason written down nobody can tell whether that fact still holds.

## What it flags

An assertion with no `SAFETY: <reason>` comment before it:

- `value as User` and `<User>value`.
- A non-null assertion `value!`, each one in a chain such as `a!.b!.c`.
- A JSDoc cast `/** @type {User} */ (value)` in `.js`, `.mjs` and `.cjs` files.

`antelopeNuxtConfig` applies the rule to `.vue` script blocks too.

These do not count as a justification: a comment after the assertion, an empty `SAFETY:`, a comment without the `SAFETY:` marker, and a `SAFETY:` comment above an enclosing `if`, loop or block when the assertion sits in a statement inside it.

These pass:

- `as const` and `<const>`.
- An assertion with a `SAFETY:` comment directly before it, inline as `/* SAFETY: ... */` or on the line above its innermost statement, declaration, class member or object property. A comment above `export` covers the exported declaration.

## Fix

First try to remove the assertion: narrow with a type guard, parse the value at its boundary, use `satisfies` for a literal, or handle `undefined` with `??` or an explicit check. When the assertion stays, write `// SAFETY: <reason>` above its statement and state the invariant that makes it true. Every `SAFETY:` comment counts toward the `safety` ceiling in `guardrails.suppressions.json`.

## Example

```ts flagged fragment [src/ports.ts]
const PORTS = new Map([
  ["http", 80],
  ["https", 443],
]);

export function defaultPort(scheme: "http" | "https"): number {
  return PORTS.get(scheme)!;
}
```

```ts fixed fragment [src/ports.ts]
const PORTS = new Map([
  ["http", 80],
  ["https", 443],
]);

export function defaultPort(scheme: "http" | "https"): number {
  // SAFETY: PORTS holds a port for every scheme the parameter type allows.
  return PORTS.get(scheme)!;
}
```
