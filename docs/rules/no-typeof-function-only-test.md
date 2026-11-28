# `antelopejs/no-typeof-function-only-test`

A test that only checks a function exists repeats what the type checker already proves and never runs the function.

## What it flags

In a test file, an `it` or `test` whose every assertion checks that a value is a function:

- `expect(x).toBeTypeOf("function")`, `expect(x).to.be.a("function")` and `expect(x).to.be.an("function")`.
- `expect(typeof x).toBe("function")` and `expect(typeof x).to.equal("function")`.
- `assert.isFunction(x)`, `assert.equal(typeof x, "function")` and `assert.strictEqual(typeof x, "function")`.

A test passes once it holds one assertion of any other kind.

## Fix

Call the function and assert what it returns, throws or changes. When a test checks that a module exports a set of functions, replace it with one test per function that calls it.

## Example

```ts fragment [src/slug.ts]
export function slugify(title: string): string {
  return title.trim().toLowerCase().replaceAll(/\s+/gu, "-");
}
```

```ts flagged fragment [test/slug.test.ts]
import assert from "node:assert/strict";

import { slugify } from "../src/slug.js";

describe("slugify", () => {
  it("is exported", () => {
    assert.equal(typeof slugify, "function");
  });
});
```

```ts fixed fragment [test/slug.test.ts]
import assert from "node:assert/strict";

import { slugify } from "../src/slug.js";

describe("slugify", () => {
  it("lowercases a title and joins its words with dashes", () => {
    assert.equal(slugify(" Release Notes "), "release-notes");
  });
});
```
