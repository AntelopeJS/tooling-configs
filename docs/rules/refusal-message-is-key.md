# `antelopejs/refusal-message-is-key`

The DMS error presenter reads the message of a 4xx refusal as a translation key, so a sentence there reaches the user untranslated.

## What it flags

In a DMS module, a package whose name or one of whose dependencies is `dms-*`, `interface-dms` or `@scope/dms-*`: `assert(condition, 4xx, message)`, `new HTTPResult(4xx, message)` and `new HTTPResult(4xx, { message })`, also under an aliased import such as `import { assert as throwHttpAssert }`, where `message` is not a translation key. The rule reads the message when it is a string, a template literal, a `const` of one, or a string literal type such as a member of an `as const` object.

A translation key is `$<module>.<key>` or `<module>.<key>`: dot-separated segments of letters, digits and `_`, with `-` also allowed in the module name. A single word such as `"Forbidden"` is a sentence.

These pass:

- Packages that are not DMS modules.
- Statuses outside 400 to 499, and a status the rule cannot read statically.
- A message the rule cannot read statically, such as a `string` parameter.
- A template literal whose substitutions each stand for one key segment: `` `$database.${kind}_not_found` ``.

## Fix

Add the sentence to the module's locale files under `<module>.<key>` and pass `$<module>.<key>` as the message. Move the values the sentence names into `params`: `new HTTPResult(404, { message: "$shop.orders.notFound", params: { id } })`, with the locale sentence reading `{id}`.

## Example

```json [package.json]
{ "name": "dms-shop", "private": true }
```

```json [frontend-vue/i18n/locales/en.json]
{ "shop": { "orders": { "notFound": "Order {id} does not exist." } } }
```

```ts flagged fragment [src/orders.ts]
import { HTTPResult } from "@antelopejs/interface-api";

export function orderNotFound(id: string): HTTPResult {
  return new HTTPResult(404, `Order ${id} does not exist`);
}
```

```ts fixed fragment [src/orders.ts]
import { HTTPResult } from "@antelopejs/interface-api";

export function orderNotFound(id: string): HTTPResult {
  return new HTTPResult(404, {
    message: "$shop.orders.notFound",
    params: { id },
  });
}
```
