# `antelopejs/no-comments`

A comment states a constraint that no tool checks, so it drifts from the code it describes.

## What it flags

- A `//` or `/* */` comment.
- A TSDoc block (`/** */`) that sits away from a declaration: inside a function body, after a blank line, or above another TSDoc block.
- A disable directive that names no rule, such as `// oxlint-disable-next-line` on its own.

These pass:

- TSDoc directly above the function, class, variable, type, enum, member or property it documents, with no blank line between them.
- A file-level TSDoc block with `@packageDocumentation`, `@module` or `@fileoverview`.
- In `.js`, `.mjs` and `.cjs` files, any JSDoc block with a type tag such as `@type`, `@param` or `@returns`.
- Lint directives that name their rules, `@ts-expect-error <reason>`, `SAFETY: <reason>`, `/*! license */` blocks, `/// <reference />`, bundler hints such as `/* @__PURE__ */` and `/* webpackChunkName: "x" */`, and formatter directives such as `// prettier-ignore`.

## Fix

Move the constraint into code: a type that rejects the wrong value, a lint rule, or a test that fails on the wrong behaviour. When the comment explains what a public declaration does, rewrite it as TSDoc directly above that declaration. Name the rule in a disable directive and give the reason after `--`.

## Example

```ts flagged fragment [src/retry.ts]
// The API drops about one request in fifty, so retry three times.
export const RETRIES = 3;
```

```ts fixed fragment [src/retry.ts]
/** The API drops about one request in fifty, so a call retries three times. */
export const RETRIES = 3;
```
