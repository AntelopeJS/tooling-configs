# Documentation checks

Keep package documentation in `<package>/docs/` and make its README the entrypoint.
Use relative links for files and headings in the checkout. Keep runtime guides in
runtime documentation and interface reference in the owning interface package.
The website mounts core reference at `/docs/interfaces` and extension reference at
`/docs/modules/<slug>/reference`; those routes are not filesystem paths.

## Run the action

Use Node.js 22.18 or newer. Pin the action to a reviewed **full commit SHA** from
this repository; it does not require an npm release or a reference to unmerged
`main`. Replace `<full-commit-sha>` below with that SHA.

Add these steps after the consumer checkout in `.github/workflows/ci.yml`:

```yaml
- uses: actions/setup-node@v4
  with:
    node-version: "24"
- uses: AntelopeJS/tooling-configs/actions/docs@<full-commit-sha>
  with:
    files: |
      README.md
      docs
```

`files` defaults to `README.md` and `docs`. Each line is a file or directory
relative to the checkout root, **not a glob**. Directories recursively select
`.md` and `.mdc` files. Missing paths and selections with no Markdown fail. In a
monorepo, list each package's README and docs directory explicitly, for example
`packages/interface-dms/README.md` and `packages/interface-dms/docs`. Paths with
spaces work. Local links resolve from their containing document, including links
to sibling packages inside the checkout.

The only other input is `typescript-project`, a consumer-owned tsconfig path.
When it is empty and the selected files contain a TypeScript fence or a
`docs-api` page, the checkout's root `tsconfig.json` is used; without one the
check fails and names the input. Install the consumer's locked dependencies
first: TypeScript must resolve from that config's directory, and third-party
packages must already exist. The repository's own packages need no build (see
below). The action does not install the consumer, build project references, or
execute examples.

## Keep versions in the generated compatibility block

`antelopejs-sync` writes each package's `@antelopejs/*` ranges into a block in
its README. The block is the only place a version of an `@antelopejs/*` package
may appear in the selected documents:

```md
<!-- antelopejs-docs-compat:start -->

| Package                      | Supported        | Tested with |
| ---------------------------- | ---------------- | ----------- |
| `@antelopejs/interface-core` | `>=0.2.4 <1.0.0` | `0.3.0`     |

<!-- antelopejs-docs-compat:end -->
```

The action checks each block against the `package.json` in the same directory.
Every `@antelopejs/*` entry of `peerDependencies`, `dependencies`, and
`optionalDependencies` needs a row (the peer range wins when a package is in
more than one), its Supported cell must agree with the manifest under the
semver comparison below, and a row for anything else fails. A block with no
`package.json` beside it, a missing end marker, or a block without `Package` and
`Supported` columns fails too. Tested with is not checked: it records what the
lockfile resolved. Each failure says to run `antelopejs-sync`.

Outside the block, these fail, each with its file, line, and the fix (run
`antelopejs-sync` and delete the prose):

- an `@antelopejs/<name>` followed by a version or range (`^1.2.0`, `~1`,
  `>=0.1.1 <1.0.0`, `1.x`, `0.4`, `v1`, `@1.2.3`), in prose, emphasis, or inline
  code, across inline code spans, parentheses, quotes, a dash, or one connector
  word (`version`, `as`, `to`, `from`, `at`);
- a table row that pairs a package with a range, whether the package is anywhere
  in a cell of the row or in the column heading; cells under a Node.js, pnpm,
  npm, Yarn, Bun, Deno, or TypeScript heading and sizes such as `1.2 MB` are not
  ranges;
- "requires" or "needs" followed by AntelopeJS and at most one word, then any
  version or range; or followed by a phrase naming AntelopeJS (such as "the
  `@antelopejs/core` package"), then `>= x` or `x.y or later` (also `newer`,
  `higher`, `above`), unless the phrase joins another requirement with "and",
  "or", "with", "plus" or "on";
- the same claims in YAML frontmatter, since `title` and `description` render.

These are not claims: fenced and indented code blocks (an install command such as
`pnpm add` with a pinned package in a `bash` fence, a `package.json` excerpt),
HTML comments, URLs and badges (the name follows `/`), package names without a
version, ranges of other packages, Node.js or tool versions, and sizes,
durations, multipliers such as `3.5x`, and IP addresses after a package name.
Files named `CHANGELOG.md` keep their version history. Migration guides are
documentation: name the release line in the heading or the file name instead of
pairing it with the package name.

Legacy `docs-compat` tables, described next, are manifest-checked, so their rows
are not prose; `antelopejs-sync` replaces them with the block.

## Declare compatibility explicitly

Put a `docs-compat` comment immediately before a top-level Markdown table with
`Package` and `Range` columns. Its path is relative to the document, and its
fragment selects `peerDependencies`, `dependencies`, `optionalDependencies`, or
`devDependencies`. Use multiple labeled tables to document different fields.

For a README beside a manifest whose `peerDependencies` hold the range in this
table:

```md
<!-- docs-compat: ./package.json#peerDependencies -->

| Package            | Range    |
| ------------------ | -------- |
| `@antelopejs/core` | `^1.2.0` |
```

Every listed package must exist in that field and its documented range must agree
with the manifest. Semver ranges use containment in both directions; common
equivalent spellings such as `^1.2.0` and `>=1.2.0 <2.0.0` pass. Workspace, file,
link, and other non-semver specs must match exactly. Copying the manifest's range
is the clearest convention. Escape table pipes as `\|` in semver unions.

Unlabeled tables that pair an `@antelopejs/*` package with a range fail as
prose (above); ranges of other packages are not checked. This check does not
require a table for every dependency or establish that a dependency range is
actually supported at runtime.

## Typecheck every TypeScript example

Every `ts`, `typescript`, `tsx`, `mts`, and `cts` fence is typechecked as a
complete module. Imports resolve as if the example were a module beside the
Markdown file. Each example is isolated, so examples cannot depend on variables
in other fences.

For example, in `docs/usage.md`:

````md
```ts
import { createClient } from "../src/index.js";

const client = createClient({ timeout: 5000 });
await client.connect();
```
````

A fence opts out only with the word `fragment` in its info string. Use it for
partial snippets, option excerpts, and pseudocode. MDC filename labels and
highlight groups are not flags, so the marker may come before or after them:

````md
```ts fragment
antelopePreset({ antiSlop: false });
```

```ts [nuxt.config.ts] fragment
modules: ["@antelopejs/dms"],
```
````

Other languages (`js`, `bash`, `json`, `vue`, …) are not checked. The former
`docs-check` opt-in is still accepted and does nothing on a TypeScript fence:
complete is the default. On any other fence it still fails.

### The repository's own packages resolve to source

An import of the repository's own package name, and of every workspace package's
name in a monorepo, resolves to that package's TypeScript source, never to a
`node_modules` copy or a stale or missing `dist`. Workspace packages come from
`pnpm-workspace.yaml` `packages` or `package.json` `workspaces` (negated `!`
patterns excluded). For each package export subpath (or `types`/`main` without
`exports`), the checker takes:

1. a `source` condition, used as is;
2. otherwise a build target (`types`, `import`, `default`, …) mapped from the
   package tsconfig's `outDir` to its `rootDir`, then from `dist` to `src`, with
   the output extension replaced by `.ts`, `.tsx`, `.mts`, `.cts`, or `/index.ts`.

Wildcard exports (`"./*": "./dist/*.js"`) map the same way. A subpath with no
matching source file keeps its normal resolution. These mappings override the
tsconfig's own `paths` for the same specifier.

### The docs program

Pass the tsconfig in the action when the root one does not fit:

```yaml
- uses: AntelopeJS/tooling-configs/actions/docs@<full-commit-sha>
  with:
    files: |
      README.md
      docs
    typescript-project: docs/tsconfig.json
```

For a typical package, `docs/tsconfig.json` can extend its normal compiler settings:

```json
{
  "extends": "../tsconfig.json",
  "compilerOptions": { "module": "NodeNext", "noUnusedLocals": false },
  "include": ["../src/**/*.ts", "./**/*.ts"]
}
```

Adjust this config to the package's actual module resolution, JSX, ambient types,
and workspace layout. Examples follow its `module` setting, so top-level `await`
needs an ES module target. The checker checks the project's included sources as
well as virtual example modules. It forces `noEmit: true` and `noCheck: false`,
clears `rootDir`, `outDir`, `declarationDir`, `tsBuildInfoFile`, and
`emitDeclarationOnly`, disables `composite` and `incremental`, and ignores
project references: virtual examples live beside the Markdown files, outside
any build layout. It never emits files.

Diagnostics name the Markdown file, the line inside it, and the TypeScript code,
for example `docs/usage.md:14: TS2322: Type 'string' is not assignable to type
'number'.` Diagnostics in other files name that file relative to the checkout.

## Check a reference page against public exports

One `docs-api` comment per reference page identifies the actual public TypeScript
entrypoint, relative to that page. Each public export needs a heading whose entire
content is its name in backticks. This convention reuses visible reference
headings instead of maintaining a second list of export names.

For an entrypoint exporting only `createClient` and the type `ClientOptions`:

```md
<!-- docs-api: ../src/index.ts -->

## `createClient`

Describe the function's inputs, result, and lifecycle here.

## `ClientOptions`

Describe the supported options here.
```

This uses the same tsconfig as the examples. Named re-exports, type exports, `export
*`, and the name `default` count. Missing headings and headings naming removed
exports fail. On a declared API page, reserve headings consisting solely of an
inline-code name for exports. Use ordinary text for other headings. Use a separate
page for each entrypoint.

The check covers **top-level export names**, not namespace/class members,
signatures in prose, or the quality of descriptions. Authors must choose the real
public entrypoints and review those details. It does not infer package export
coverage from `package.json`, enforce docs location, or require annotations.

## Link coverage and intentional exclusions

The checker validates relative Markdown links and images, resolved reference
links, literal HTML `<a href>`/`<img src>` destinations, and local heading links.
It recognizes GitHub-style heading slugs (including duplicates), explicit HTML
`id`/anchor `name` attributes, and heading `{#custom-id}` suffixes. Encoded paths
and fragments are decoded; query strings do not change the target file.

Only Markdown targets get anchor checks. Source-code line fragments and asset
fragments are left to their viewers. Links to existing directories are accepted.
Targets must stay inside the checkout, including through symlinks. Selected files
are checked, while linked Markdown outside the selection is read only for anchors.

Absolute `/...` routes, protocol-relative URLs, and URLs with a scheme are not
fetched or checked. YAML frontmatter, code examples, comments, and dynamic MDC/Vue
attributes are not navigation. This is a Markdown check, **not a Nuxt/MDC renderer**:
website route mounts, redirects, component navigation, renderer-specific anchors,
and unresolved reference-like text still need website checks and author review.
Keep a blank line around Markdown inside HTML containers, as in CommonMark.

All content checks run locally. The action downloads four locked public npm
dependencies with lifecycle scripts and auditing disabled; it sends no consumer
documents, source, or diagnostics to an external checking service. It works with
public or private checkouts and needs no extra token. Use ordinary `pull_request`
CI, not privileged `pull_request_target` execution of untrusted checkout code.

## Run locally at the same revision

Run from the consumer checkout root, replacing the SHA with the one used in CI:

```bash
DOCS_SHA="<full-commit-sha>"
guardrail=$(mktemp -d)
git clone --quiet https://github.com/AntelopeJS/tooling-configs.git "$guardrail"
git -C "$guardrail" checkout --quiet "$DOCS_SHA"
npm ci --prefix "$guardrail/actions/docs" --omit=dev --ignore-scripts --no-audit --no-fund
node "$guardrail/actions/docs/check.mjs" README.md docs
# Add --typescript-project docs/tsconfig.json when the root tsconfig.json does not fit.
rm -rf "$guardrail"
```

When contributing to this repository, run `pnpm install --frozen-lockfile` and
`pnpm checks` for the existing presets. Test the independent action with:

```bash
npm ci --prefix actions/docs --ignore-scripts --no-audit --no-fund
npm test --prefix actions/docs
node actions/docs/check.mjs README.md docs
```

CI runs the action tests and the composite action itself on Node.js 22.18 and 24.
No package publication is part of this workflow.
