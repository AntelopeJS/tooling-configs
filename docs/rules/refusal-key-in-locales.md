# `antelopejs/refusal-key-in-locales`

A refusal key that no locale file of the module holds reaches the DMS error presenter, which then shows the raw `$<ns>.<key>` text to the user.

## What it flags

`assert(condition, 4xx, message)`, `new HTTPResult(4xx, message)` and `new HTTPResult(4xx, { message })`, also under an aliased import such as `import { assert as throwHttpAssert }`, where:

- `message` is a string, a template literal without substitutions, a `const` of one, or a string literal type such as a member of an `as const` object, and reads `$<ns>.<key>`;
- `<ns>` is a top-level key of one of the module's locale files, every `i18n/locales/*.json` under the `frontend-vue` directory beside the nearest `package.json` that has a `name`, layers included;
- and no locale file holds `<ns>.<key>` as a sentence. A key that names a group of sentences counts as missing.

These pass:

- A namespace the module's locale files do not own, such as another module's keys.
- A module with no locale files.
- Keys built from a template substitution, keys without the `$` prefix, and statuses outside 400 to 499.

## Fix

Add the sentence under that key to the module's locale files. When the key has a typo, correct it to the key the locale files hold.

## Example

```json [package.json]
{ "name": "dms-shop", "private": true }
```

```ts fragment [src/orders.ts]
import { assert } from "@antelopejs/interface-api-util";

interface Order {
  id: string;
}

export function requireOrder(order: Order | undefined): void {
  assert(order !== undefined, 404, "$shop.orders.notFound");
}
```

```json flagged [frontend-vue/i18n/locales/en.json]
{ "shop": { "orders": { "cancelled": "This order was cancelled." } } }
```

```json fixed [frontend-vue/i18n/locales/en.json]
{
  "shop": {
    "orders": {
      "cancelled": "This order was cancelled.",
      "notFound": "This order does not exist."
    }
  }
}
```
