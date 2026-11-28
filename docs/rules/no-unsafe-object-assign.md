# `antelopejs/no-unsafe-object-assign`

`Object.assign<T, U>` returns `T & U` without comparing `U` with `T`, so a source can write `unknown`, `any` or a wrong type over a field the target declares and the compiler never sees it.

## What it flags

With type-aware lint on, `Object.assign(target, ...sources)` where a source writes over a property the target's type declares:

- A whole source typed `unknown` or `any`, or holding such values under a `string` index signature, such as `Object.fromEntries` of `[string, unknown]` pairs, while the target has a field that does not take `unknown`.
- A source property typed `unknown` or `any`, or holding `any` in its elements: `{ stages: JSON.parse(text) }`, `{ stages: [value] }` with `value: any`.
- A source property whose type neither the target field nor its setter accepts: `{ value: "one" }` over `value?: number`. Literals are checked as a direct assignment checks them, so missing, misspelled and extra nested properties and wrong tuple lengths count.

A union source such as `flag && { stages }` is checked member by member. An optional source property may hold `undefined` unless `exactOptionalPropertyTypes` is on, but not `null`.

These pass:

- Properties the target does not declare: `Object.assign(new Error(message), { code })`.
- Target fields typed `unknown` or `any`.
- Assignable values, a `Partial<T>` source over a `T`, a copy into `{}`, spread sources, and setters declared in a generic class, interface or type alias.

## Fix

Parse the untyped value into the field's type before it reaches `Object.assign`: a type guard, a `typeof` check, or a schema. For a value of the wrong type, assign the field directly (`target.value = next`) so the compiler checks it, then fix the type the compiler reports. `Object.assign` stays fine for adding fields the target does not declare.

## Example

```ts flagged fragment [src/restore.ts]
interface Job {
  id: string;
  attempts: number;
}

export function restore(job: Job, text: string): Job {
  return Object.assign(job, { attempts: JSON.parse(text) });
}
```

```ts fixed fragment [src/restore.ts]
interface Job {
  id: string;
  attempts: number;
}

function isAttempts(value: unknown): value is number {
  return Number.isInteger(value);
}

function parseAttempts(text: string): number {
  const attempts: unknown = JSON.parse(text);
  if (!isAttempts(attempts)) throw new TypeError("attempts is not an integer");
  return attempts;
}

export function restore(job: Job, text: string): Job {
  return Object.assign(job, { attempts: parseAttempts(text) });
}
```
