# `anti-slop/no-unknown-returns`

A function that returns `unknown` hands the parsing of its result to every caller, so each one checks it differently or not at all.

## What it flags

An explicit return type that is `unknown`, `Promise<unknown>` or `PromiseLike<unknown>`, a union that contains `unknown`, or an alias declared in the same file that resolves to one of these, such as `type Payload = unknown` or `Identity<unknown>`. It checks functions, arrow functions, declared functions, function types, call and construct signatures, and method signatures.

These pass:

- A function with no return annotation.
- A type parameter as the return type, such as `<Value>(): Value`.
- `unknown` nested in a returned object, such as `{ cause: unknown }`.
- A return type named with an alias the file imports.

## Fix

Parse the value inside the function and return a named domain type. When the value comes from `JSON.parse`, a file, a request body or a response, run the type guard or schema there and return `User` or `Promise<User>`. When the function only forwards a value it does not inspect, make it generic over that value's type.

## Example

```ts flagged fragment [src/config.ts]
import { readFile } from "node:fs/promises";

export async function loadConfig(path: string): Promise<unknown> {
  const text = await readFile(path, "utf8");
  return JSON.parse(text);
}
```

```ts fixed fragment [src/config.ts]
import { readFile } from "node:fs/promises";

export interface Config {
  readonly port: number;
}

function isConfig(value: unknown): value is Config {
  return (
    typeof value === "object" &&
    value !== null &&
    "port" in value &&
    typeof value.port === "number"
  );
}

export async function loadConfig(path: string): Promise<Config> {
  const data: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!isConfig(data)) throw new TypeError(`${path} has no numeric port`);
  return data;
}
```
