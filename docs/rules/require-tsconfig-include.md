# `antelopejs/require-tsconfig-include`

Type-aware lint reads a file no tsconfig lists without the repository's compiler options or `types`, so its `typescript/no-unsafe-*` reports there are false and findings that need those types go missing.

## What it flags

With type-aware lint on:

- A TypeScript or JavaScript file that no `tsconfig.json` or `jsconfig.json` lists: not the nearest one, not a config it references, not one above it. Common cases are `scripts/` and root config files outside `"include": ["src"]`, and JavaScript files under a tsconfig without `allowJs`.
- An import in a TypeScript or `.vue` file that the tsconfig listing it cannot resolve: a static `import` with a specifier, an `export … from`, or an `import("…")` of a string. A path alias with no `paths` entry is the usual cause.
- A `.vue` script that declares a name but imports and exports nothing, when its tsconfig does not set `compilerOptions.moduleDetection` to `"force"`.

These pass:

- The root `oxlint.config.ts`, `oxfmt.config.ts` and `knip.config.ts` that `antelopejs-sync` writes.
- A side-effect `import "./x.css"`, an import in a JavaScript file, an untyped package, a module a `declare module` in a listed file declares, and an import of a `.vue` component.

## Fix

- A file outside every tsconfig: list it in a tsconfig that names the `types` it uses, such as a `tsconfig.json` beside it that extends the root one. For a file at the root, use a composite tsconfig that the root tsconfig references. For JavaScript files, set `allowJs`.
- An unresolved import: give the tsconfig that lists the file the `paths`, `baseUrl` or `node_modules` that reach the module. In a Nuxt layer, use a `tsconfig.json` that extends the generated `.nuxt/tsconfig.json`, and run `nuxt prepare` before lint.
- A global `.vue` script: set `"moduleDetection": "force"` in its tsconfig, as `.nuxt/tsconfig.json` does.

## Example

```js [scripts/version.mjs]
export const version = process.env.npm_package_version ?? "0.0.0";
```

```json flagged [tsconfig.json]
{
  "extends": "../tsconfig.json",
  "include": ["src"]
}
```

```json fixed [tsconfig.json]
{
  "extends": "../tsconfig.json",
  "compilerOptions": { "allowJs": true, "noEmit": true },
  "include": ["src", "scripts"]
}
```
