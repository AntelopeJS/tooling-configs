# `anti-slop/no-unknown-type-aliases`

An alias of `unknown` gives an unparsed value a name that reads like a domain type, so code that uses it looks checked when it is not.

## What it flags

A type alias whose type resolves to `unknown`, in any scope:

- `type Payload = unknown`.
- A union that contains `unknown`, such as `type Payload = string | unknown`.
- An alias of such an alias, such as `type Body = Payload`.
- A generic alias instantiated with `unknown` that resolves to it, such as `type Payload = Identity<unknown>`.

These pass:

- An alias whose type holds `unknown` inside a structure, such as `type Payload = Box<unknown>` or `{ readonly value: unknown }`.
- An alias of any other type.

## Fix

Delete the alias. Write `unknown` where the raw value enters, at the parsing boundary or on a `cause` field, and give the parsed value its own type. When the alias names a payload whose fields you know, declare those fields.

## Example

```ts flagged fragment [src/webhooks.ts]
export type WebhookPayload = unknown;

export interface WebhookEvent {
  readonly name: string;
  readonly payload: WebhookPayload;
}
```

```ts fixed fragment [src/webhooks.ts]
export interface WebhookPayload {
  readonly orderId: string;
  readonly status: "paid" | "refunded";
}

export interface WebhookEvent {
  readonly name: string;
  readonly payload: WebhookPayload;
}
```
