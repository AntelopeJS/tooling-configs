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
Install the consumer's locked dependencies first when using it. TypeScript must
resolve from that config's directory, and imported packages must already exist
(including any necessary generated declarations). The action does not install
the consumer, build project references, or execute examples.

## Declare compatibility explicitly

Put a `docs-compat` comment immediately before a top-level Markdown table with
`Package` and `Range` columns. Its path is relative to the document, and its
fragment selects `peerDependencies`, `dependencies`, `optionalDependencies`, or
`devDependencies`. Use multiple labeled tables to document different fields.

For a README beside a manifest that declares `@antelopejs/core` as `^1.2.0`:

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

Unlabeled prose and tables are not checked. This check does not require a table
for every dependency or establish that a dependency range is actually supported
at runtime. Authors select the compatibility claims they intend to maintain.

## Mark complete TypeScript examples

Add `docs-check` to the info string of a complete `ts`, `typescript`, or `tsx`
fence. Imports resolve as if the example were a module beside the Markdown file.
Each example is isolated, so examples cannot depend on variables in other fences.

For example, in `docs/usage.md`:

````md
```ts docs-check
import { createClient } from "../src/index.js";

const client = createClient({ timeout: 5000 });
await client.connect();
```
````

Pass the tsconfig in the action:

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
  "compilerOptions": {
    "noEmit": true,
    "rootDir": "..",
    "composite": false,
    "incremental": false
  },
  "include": ["../src/**/*.ts", "./**/*.ts"]
}
```

Adjust this config to the package's actual module resolution, JSX, ambient types,
and workspace layout. The checker checks the project's included sources as well
as virtual example modules. It forces `noCheck: false` and never emits files.
Diagnostics identify the
Markdown filename and numbered example, with line numbers relative to that
example. An annotation without `typescript-project` fails instead of silently
skipping the check. Unannotated fences remain pseudocode or partial illustrations.

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

This also requires `typescript-project`. Named re-exports, type exports, `export
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
# Add --typescript-project docs/tsconfig.json for annotated examples/API pages.
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
