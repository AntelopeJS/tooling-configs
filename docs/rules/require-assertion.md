# `antelopejs/require-assertion`

A test with no assertion passes whatever the code does, so it reports coverage it does not give.

## What it flags

In a test file, an `it` or `test` callback, including `.only`, `.concurrent`, `.serial` and `.fails`, that calls no assertion. An assertion in the body of a helper the test calls does not count: the rule reads only the test's own callback.

These count as assertions:

- Calls whose name starts with `expect` or `assert`, such as `expect(x)`, `assert.equal(...)` and `assertValidUser(...)`.
- `sinon.assert.*`, a supertest `.expect(...)`, and should-style `x.should…` or `should(x)`.

`it.skip`, `it.todo` and a test with no callback are not checked.

## Fix

Assert the outcome the test exists to prove: the value returned, the error thrown, the state changed or the response sent. A test that checks only that a call does not throw asserts it, with `assert.doesNotThrow(...)` or `await assert.doesNotReject(...)`. When a shared helper checks the outcome, name it `assert…` or `expect…` so it counts.

## Example

```ts fragment [src/users.ts]
export interface User {
  name: string;
  active: boolean;
}

export function createUser(name: string): User {
  return { name, active: true };
}
```

```ts flagged fragment [test/users.test.ts]
import { createUser } from "../src/users.js";

describe("createUser", () => {
  it("makes an active user", () => {
    createUser("Ada");
  });
});
```

```ts fixed fragment [test/users.test.ts]
import assert from "node:assert/strict";

import { createUser } from "../src/users.js";

describe("createUser", () => {
  it("makes an active user", () => {
    assert.deepEqual(createUser("Ada"), { name: "Ada", active: true });
  });
});
```
