# `antelopejs/no-constant-value-assertion`

A test that restates a constant's value fails only when someone edits the constant on purpose, and never when the code that uses it breaks.

## What it flags

In a test file, an equality assertion whose actual value is an UPPER_SNAKE constant, or a property of one, and whose expected value is a literal:

- `expect(MAX_ITEMS).toBe(50)` and `expect(LIMITS.upload).toEqual(1024)`.
- The same with `.toStrictEqual`, `.to.equal`, `.to.eq`, `.eql`, `.to.deep.equal` and their synonyms.
- An expected array or object made only of literals, such as `expect(ROLES).toEqual(["admin", "viewer"])`.

An actual value whose root is not UPPER_SNAKE, such as `process.env.NODE_ENV` or `config.maxItems`, passes.

## Fix

Assert the behaviour the constant drives: call the code that reads it and check the outcome at its boundary. For a limit, assert that the last allowed value passes and the next one is refused.

## Example

```ts fragment [src/cart.ts]
export const MAX_ITEMS = 50;

export function canAdd(count: number): boolean {
  return count < MAX_ITEMS;
}
```

```ts flagged fragment [test/cart.test.ts]
import { expect, test } from "vitest";

import { MAX_ITEMS } from "../src/cart.js";

test("the cart holds fifty items", () => {
  expect(MAX_ITEMS).toBe(50);
});
```

```ts fixed fragment [test/cart.test.ts]
import { expect, test } from "vitest";

import { canAdd } from "../src/cart.js";

test("the cart takes a fiftieth item and refuses a fifty-first", () => {
  expect(canAdd(49)).toBe(true);
  expect(canAdd(50)).toBe(false);
});
```
