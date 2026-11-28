# `anti-slop/no-unknown-parameters`

A parameter typed `unknown` moves the parsing of untrusted input into whatever function receives it, so no single place owns the check.

## What it flags

A parameter annotated `unknown`, or a union that contains `unknown` such as `string | unknown`. It checks functions, arrow functions, methods, constructors, declared functions, function types and method signatures in interfaces and type literals.

These pass:

- A parameter named `cause`.
- The subject of a type predicate: `value` in `(value: unknown): value is User` or `asserts value is User`.
- A `this` parameter.
- A parameter decorated `@JSONBody`, `@JsonBody` or `@Parameter`: the request value interface-api and dms-lang inject.
- The rejection reason of a callback written directly in `.catch(...)` or as the second argument of `.then(...)`, and the parameter of a `(reason: unknown) => void` type declared as `reject` or on a `new Promise` executor.
- A validator's input that the body narrows before any other use. Every read is the argument of a type-guard call that is the test of an `if` or `?:` or the left operand of `&&` or `||`, the argument of a schema's `.decode`, `.parse` or `.safeParse`, or sits inside the branch such a guard makes true.

The rule reads only the written annotation, so a parameter typed with an alias of `unknown` passes here. `anti-slop/no-unknown-type-aliases` reports that alias.

## Fix

Accept the parsed domain type, and parse the raw value once at the I/O boundary before the call.

- A function that works on the value: type the parameter with the domain type and move the parsing to the caller that read the input.
- A validator: return a type predicate (`value is User`), or narrow the parameter with a type guard or a schema decode before any other read.
- An error helper: write the callback inline in `.catch(...)`, or name the parameter `cause` when it wraps the error in a new one.

## Example

```ts flagged fragment [src/orders.ts]
export interface Order {
  readonly id: string;
  readonly total: number;
}

export function describeOrder(order: unknown): string {
  return JSON.stringify(order);
}
```

```ts fixed fragment [src/orders.ts]
export interface Order {
  readonly id: string;
  readonly total: number;
}

export function describeOrder(order: Order): string {
  return `${order.id}: ${order.total}`;
}
```
