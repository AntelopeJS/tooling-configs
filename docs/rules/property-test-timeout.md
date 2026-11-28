# `antelopejs/property-test-timeout`

A fast-check property runs a fixed number of runs whose time depends on the host's load, so a mocha timeout fails it on a busy CI runner and leaves it running into later tests.

## What it flags

In a mocha test file, an `it` or `test` that calls `fc.assert` or `fc.check` under a timeout other than 0:

- No `this.timeout(...)` call in the test or in any enclosing `describe`, `context` or `suite`, which leaves it on the default timeout.
- A `this.timeout(n)` with `n` other than 0, in the test's callback or in the nearest enclosing describe that sets one.

These pass:

- `this.timeout(0)` in the test's callback, or in the nearest enclosing describe that sets a timeout.
- Files that import `vitest`, `node:test` or `bun:test`, which do not run under mocha.

## Fix

Call `this.timeout(0)` in the test or in its describe. `this` is mocha's context only inside a `function` callback, so write that callback as `function () { … }`, not as an arrow function. The property's `numRuns` bounds its work, and the CI job's `timeout-minutes` ends a hang.

## Example

```ts fragment [src/sum.ts]
export function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
```

```ts flagged fragment [test/sum.test.ts]
import { strict as assert } from "node:assert";
import fc from "fast-check";

import { sum } from "../src/sum.js";

describe("sum", () => {
  it("does not depend on the order of its values", () => {
    fc.assert(
      fc.property(fc.array(fc.integer()), (values) => {
        assert.equal(sum([...values].reverse()), sum(values));
      }),
    );
  });
});
```

```ts fixed fragment [test/sum.test.ts]
import { strict as assert } from "node:assert";
import fc from "fast-check";

import { sum } from "../src/sum.js";

describe("sum", () => {
  it("does not depend on the order of its values", function () {
    this.timeout(0);
    fc.assert(
      fc.property(fc.array(fc.integer()), (values) => {
        assert.equal(sum([...values].reverse()), sum(values));
      }),
    );
  });
});
```
