import { RuleTester } from "oxlint/plugins-dev";

import { noChainedTypeAssertionsRule } from "./no-chained-type-assertions.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });
const error = { messageId: "chained" };

tester.run("anti-slop/no-chained-type-assertions", noChainedTypeAssertionsRule, {
  valid: [
    "const value = input as User;",
    "const value = (input as User);",
    "const value = ({ id: 1 } as const) as const;",
    {
      name: "phantom retype of this to its own class",
      code: "class Datum<T> { cast<U>(): Datum<U> { return this as unknown as Datum<U>; } }",
    },
    {
      name: "phantom retype inside an arrow in a method",
      code: "class Stream<T> { cast<U>() { const retype = () => (this as unknown) as Stream<U>; return retype(); } }",
    },
    {
      name: "phantom retype in an exported class",
      code: "export class ValueProxy<T> { get typed(): ValueProxy<string> { return <ValueProxy<string>>(<unknown>this); } }",
    },
  ],
  invalid: [
    { name: "as chain", code: "const value = input as unknown as User;", errors: [error] },
    {
      name: "parenthesized chain",
      code: "const value = (input as unknown) as User;",
      errors: [error],
    },
    {
      name: "angle-bracket chain",
      code: "const value = <User>(<unknown>input);",
      errors: [error],
    },
    {
      name: "mixed const chain",
      code: "const value = ({ id: 1 } as const) as User;",
      errors: [error],
    },
    {
      name: "this retyped to another class",
      code: "class Datum<T> { cast(): Other<T> { return this as unknown as Other<T>; } }",
      errors: [error],
    },
    {
      name: "this retyped without type arguments",
      code: "class Datum<T> { cast(): Datum { return this as unknown as Datum; } }",
      errors: [error],
    },
    {
      name: "this retyped through a type other than unknown",
      code: "class Datum<T> { cast<U>(): Datum<U> { return this as any as Datum<U>; } }",
      errors: [error],
    },
    {
      name: "static this is the constructor, not an instance",
      code: "class Datum<T> { static cast<U>(): Datum<U> { return this as unknown as Datum<U>; } }",
      errors: [error],
    },
    {
      name: "this rebound by a nested function",
      code: "class Datum<T> { cast<U>() { return function () { return this as unknown as Datum<U>; }; } }",
      errors: [error],
    },
    {
      name: "this rebound by a function declared in a method",
      code: "class Datum<T> { cast<U>() { function retype() { return this as unknown as Datum<U>; } return retype; } }",
      errors: [error],
    },
    {
      name: "this in a static block of a class nested in a method",
      code: "class Datum<T> { cast<U>() { class Inner { static { const x = this as unknown as Datum<U>; } } } }",
      errors: [error],
    },
    {
      name: "member of this retyped",
      code: "class Datum<T> { cast<U>() { return this.inner as unknown as Datum<U>; } }",
      errors: [error],
    },
    {
      name: "triple chain from this",
      code: "class Datum<T> { cast<U>() { return this as unknown as Datum<unknown> as Datum<U>; } }",
      errors: [error],
    },
    {
      name: "anonymous class has no name to match",
      code: "const Datum = class<T> { cast<U>() { return this as unknown as Datum<U>; } };",
      errors: [error],
    },
    {
      name: "this outside any class",
      code: "function cast<U>(this: Datum<string>) { return this as unknown as Datum<U>; }",
      errors: [error],
    },
  ],
});
