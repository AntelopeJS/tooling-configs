# `anti-slop/no-module-mocking`

A module mock swaps an import behind the code's back, so the test passes against a fake that no type or interface keeps in step with the real module.

## What it flags

- `vi.mock`, `vi.doMock`, `jest.mock`, `jest.doMock` and `jest.unstable_mockModule`, also called with a computed name such as `vi["doMock"]`.
- The same calls on `vi` imported from `vitest` or `jest` imported from `@jest/globals`, under any local name, such as `import { vi as t } from "vitest"`.

These pass:

- `vi.spyOn`, `vi.fn` and other calls that do not replace a module.
- A local variable or parameter named `vi` or `jest`, and a `vi` imported from any module other than `vitest`.

## Fix

Pass the dependency in through an interface the production code owns: a constructor or function parameter typed by that interface. In the test, pass a small in-memory implementation of the interface, and assert on its state.

## Example

```ts flagged fragment [test/signup.test.ts]
import { expect, test, vi } from "vitest";

import { signUp } from "../src/signup.ts";
import { saveUser } from "../src/user-store.ts";

vi.mock("../src/user-store.ts");

test("signUp saves the address", async () => {
  await signUp("ada@example.com");
  expect(saveUser).toHaveBeenCalledWith("ada@example.com");
});
```

```ts fixed fragment [src/signup.ts]
export interface UserStore {
  save(email: string): Promise<void>;
}

export async function signUp(store: UserStore, email: string): Promise<void> {
  await store.save(email);
}
```

```ts fixed fragment [test/signup.test.ts]
import { expect, test } from "vitest";

import { signUp, type UserStore } from "../src/signup.ts";

class InMemoryUserStore implements UserStore {
  readonly emails: string[] = [];

  save(email: string): Promise<void> {
    this.emails.push(email);
    return Promise.resolve();
  }
}

test("signUp saves the address", async () => {
  const store = new InMemoryUserStore();
  await signUp(store, "ada@example.com");
  expect(store.emails).toEqual(["ada@example.com"]);
});
```
