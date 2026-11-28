# `anti-slop/no-reflect-apply`

`Reflect.apply` calls a function with an argument array the compiler does not match against its parameters, so a wrong argument passes the type check.

## What it flags

- A call to the global `Reflect.apply` or `Reflect["apply"]`.

These pass:

- A direct call, and `fn.call(owner, ...)` or `fn.apply(owner, args)` on a function value.
- A local variable or parameter named `Reflect`.

## Fix

- Call the function directly: `handler(input)` in place of `Reflect.apply(handler, undefined, [input])`.
- For a method, call it on its owner: `owner.method(input)`.
- When the function to call is picked at run time, put the candidates in an object typed by a named interface and call the one you pick through it.

## Example

```ts flagged fragment [src/run.ts]
export function run(handler: (input: string) => number, input: string): number {
  return Reflect.apply(handler, undefined, [input]);
}
```

```ts fixed fragment [src/run.ts]
export function run(handler: (input: string) => number, input: string): number {
  return handler(input);
}
```
