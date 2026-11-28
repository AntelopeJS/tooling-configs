# `anti-slop/no-chained-type-assertions`

An assertion through `unknown` or another type tells the compiler to accept any value as the target type, so a wrong shape reaches the code that reads it.

## What it flags

- An `as` chain such as `value as unknown as User`, with or without parentheses around the inner assertion.
- An angle-bracket chain such as `<User>(<unknown>value)`.
- A chain that mixes `as const` with another assertion, such as `({ id: 1 } as const) as User`.

These pass:

- A single assertion, such as `value as User`. `require-safety-comment-for-type-assertion` still asks for a `SAFETY:` comment above it.
- A chain made only of `as const`.
- `this as unknown as C<U>` in a non-static method of a named class `C`, when the inner assertion is to `unknown` and `C<U>` has type arguments. It retypes the same instance under other type arguments. A nested `function`, a `this` parameter, a static method or an anonymous class removes the exemption.

## Fix

- Untrusted input, such as `JSON.parse` output or a request body: bind it as `unknown`, decode it with a type guard or a schema, and use the decoded value.
- A value whose type is already known: drop the chain and fix the type at its source, so the value keeps its precise type.
- A class that changes a phantom type parameter: return `this as unknown as C<U>` from a method of `C`.

## Example

```ts flagged fragment [src/users.ts]
export interface User {
  readonly id: string;
}

export function readUser(body: string): User {
  return JSON.parse(body) as unknown as User;
}
```

```ts fixed fragment [src/users.ts]
export interface User {
  readonly id: string;
}

function isUser(value: unknown): value is User {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    typeof value.id === "string"
  );
}

export function readUser(body: string): User {
  const value: unknown = JSON.parse(body);
  if (!isUser(value)) throw new Error("The body is not a user.");
  return value;
}
```
