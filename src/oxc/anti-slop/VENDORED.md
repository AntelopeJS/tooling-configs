# anti-slop (vendored)

Copied from <https://github.com/dmmulroy/anti-slop> at commit `e8c4880471b23ab7f216fba7b27d173a6ef07d4c` (2026-08-31), MIT license (see `LICENSE` in this directory).

The upstream project is meant to be vendored, not installed from npm. The `effect/` rule group was intentionally left out (we do not use Effect). Everything else is unchanged; local edits, if any, are listed below.

## Local edits

- `rules/require-safety-comment-for-type-assertion.ts` exports `DEFAULT_SAFETY_MARKERS` and `markerPattern`, so the guardrails suppression counter counts exactly the `SAFETY:` comments this rule accepts.
- `rules/no-runtime-typeof.ts` also reports `x.constructor === String` (and `Number`, `Boolean`, `BigInt`, `Symbol`, `Function`), a `typeof` check in another form, with the same `allowInTypeGuards` exemption.
- `shared/type-guards.ts` holds the type-guard detection `no-runtime-typeof` had inline, so `no-unsafe-dictionary-type` reuses it. In a `.js` or `.mjs` file, a function whose JSDoc block declares `@returns {x is T}` for one of its parameters is a type guard too, so `allowInTypeGuards` covers plain JavaScript guards.
- `rules/no-unknown-parameters.ts` also skips a TypeScript `this` parameter; a parameter decorated with `@JSONBody`, `@JsonBody` or `@Parameter` (the request values interface-api and dms-lang inject); the first parameter of a callback passed directly to `.catch(...)` or as the second argument of `.then(...)`; and the parameter of a `(reason: unknown) => void` type declared as `reject` or on a `new Promise` executor's second parameter.
- `rules/no-unknown-parameters.ts` also skips a parameter typed exactly `unknown` that a function only passes to a schema or decoder and whose result is every value the function returns, under a declared return type other than `unknown` or `any`. `shared/parse-boundary.ts` holds this check.
- `rules/no-unsafe-dictionary-type.ts` allows exactly `Record<string, unknown>` as the target of a `value is T` predicate or inside the body of a type guard.
