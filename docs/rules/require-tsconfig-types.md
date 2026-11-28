# `antelopejs/require-tsconfig-types`

A tsconfig with no `compilerOptions.types` loads every `@types` package under TypeScript 5 but none under the TypeScript 7 that type-aware lint runs, so Node and test-runner globals are error types there and its `typescript/no-unsafe-*` reports are false.

## What it flags

With type-aware lint on, a TypeScript or JavaScript file whose tsconfig lists no `compilerOptions.types`, neither itself nor through `extends`, in a package whose installed `typescript` is version 5 or earlier and has `@types` packages for tsc to load. The report names the config and the packages tsc loads.

These pass:

- A tsconfig that sets `types`, or extends one that does.
- A package on TypeScript 6 or 7, whose tsc loads no `@types` package without `types` either.
- A package with no `@types` package installed.
- The root `oxlint.config.ts`, `oxfmt.config.ts` and `knip.config.ts` that `antelopejs-sync` writes.

## Fix

Add `"types"` to the tsconfig's `compilerOptions`, or to the config that generates it, listing the `@types` packages the code uses, such as `"types": ["node"]` or `"types": ["node", "mocha"]`. A package that uses no global types sets `"types": []`.

## Example

```json [node_modules/typescript/package.json]
{ "name": "typescript", "version": "5.9.3" }
```

```ts fragment [node_modules/@types/node/index.d.ts]
declare const process: { cwd(): string };
```

```json flagged [tsconfig.json]
{
  "compilerOptions": { "strict": true, "module": "nodenext" },
  "include": ["src"]
}
```

```json fixed [tsconfig.json]
{
  "compilerOptions": {
    "strict": true,
    "module": "nodenext",
    "types": ["node"]
  },
  "include": ["src"]
}
```

```ts fragment [src/root.ts]
export function root(): string {
  return process.cwd();
}
```
