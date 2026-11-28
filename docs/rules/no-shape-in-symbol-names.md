# `anti-slop/no-shape-in-symbol-names`

A name with "shape" in it says how a value is laid out instead of what it is, so a reader learns nothing about the domain it belongs to.

## What it flags

Every identifier whose name contains `shape` in any case, wherever it appears:

- A variable, function, parameter, class, interface, type alias or enum, such as `UserShape`, `shapeOf` or `reshape`.
- A property or method key in an object, a class or a type, such as `{ shape: string }`, and a private `#shape`.
- A JSX element or attribute name.
- Every reference to such a binding, not only its declaration.

These pass:

- A property read with a dot, such as zod's `schema.shape.id`.
- Strings and comments.

## Fix

Rename the symbol for the role it plays in the domain. A type that describes a record takes the record's name (`UserShape` becomes `User`). A function that builds or checks one names the action and the record (`shapeOf` becomes `parseUser` or `toUser`). A property named `shape` takes the name of what it holds, such as `schema` or `fields`.

## Example

```ts flagged fragment [src/users.ts]
export interface UserShape {
  readonly id: string;
  readonly email: string;
}
```

```ts fixed fragment [src/users.ts]
export interface User {
  readonly id: string;
  readonly email: string;
}
```
