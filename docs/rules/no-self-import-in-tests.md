# `antelopejs/no-self-import-in-tests`

A test that imports its own package name loads the installed published copy, so it never runs the local code it claims to test.

## What it flags

In a test file, an import of the name in the nearest `package.json`, or of a subpath of it: a static `import`, `export … from`, dynamic `import()`, `require()` or `import x = require()`.

These pass:

- `import type` and imports whose specifiers are all type-only.
- A self-import that reaches local code: the `exports` map in `package.json` publishes the subpath, and `node_modules/<name>` is a link back to the package itself, as `"<name>": "link:."` in `devDependencies` makes it.

In a package whose `package.json` sets `antelopeJs.test`, `ajs module test` resolves the name through its own module resolver, so a self-link proves nothing there and every self-import is reported.

## Fix

Import the module under test by relative path, such as `../src/users.js`. Outside `ajs module test`, a package that tests its published entry points can keep the self-import instead: publish the subpath in `exports` and add the self-link `"<name>": "link:."` to `devDependencies`.

## Example

```json [package.json]
{
  "name": "@acme/users",
  "type": "module",
  "exports": "./dist/index.js"
}
```

```ts fragment [src/users.ts]
export function displayName(first: string, last: string): string {
  return `${first} ${last}`;
}
```

```ts flagged fragment [test/users.test.ts]
import assert from "node:assert/strict";

import { displayName } from "@acme/users";

describe("displayName", () => {
  it("joins the first and last name", () => {
    assert.equal(displayName("Ada", "Lovelace"), "Ada Lovelace");
  });
});
```

```ts fixed fragment [test/users.test.ts]
import assert from "node:assert/strict";

import { displayName } from "../src/users.js";

describe("displayName", () => {
  it("joins the first and last name", () => {
    assert.equal(displayName("Ada", "Lovelace"), "Ada Lovelace");
  });
});
```
