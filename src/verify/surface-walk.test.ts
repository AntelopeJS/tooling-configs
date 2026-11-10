import assert from "node:assert/strict";
import test from "node:test";

import {
  changedPaths,
  surfaceOf,
  TYPES_MANIFEST,
} from "./helpers/surface-fixture.ts";

test("a member type changing in a base interface is a changed function that answers the derived interface", () => {
  const source = (type: string) =>
    `interface Base { id: ${type}; }\ninterface Row extends Base { name: string; }\nexport declare function row(): Row;\n`;
  assert.deepEqual(changedPaths(source("number"), source("string")), [".:row"]);
});

test("a constraint changing on a generic parameter is a changed function", () => {
  const source = (type: string) =>
    `interface Shape { size: ${type}; }\nexport declare function measure<T extends Shape>(value: T): T;\n`;
  assert.deepEqual(changedPaths(source("number"), source("string")), [
    ".:measure",
  ]);
});

test("an enum member value changing is a changed function that takes the member", () => {
  const source = (value: number) =>
    `export declare enum Mode { Fast = ${value}, Slow = 5 }\nexport declare function run(mode: Mode.Fast): void;\n`;
  assert.deepEqual(changedPaths(source(1), source(2)), [".:run"]);
});

test("two declarations of one name in different modules are both reached", () => {
  const source = () =>
    `import type { Item as Left } from "./left";\nimport type { Item as Right } from "./right";\nexport declare function pair(left: Left, right: Right): void;\n`;
  const published = surfaceOf(TYPES_MANIFEST, [
    ["index.d.ts", source()],
    ["left.d.ts", "export interface Item { a: number; }\n"],
    ["right.d.ts", "export interface Item { b: number; }\n"],
  ]);
  const head = surfaceOf(TYPES_MANIFEST, [
    ["index.d.ts", source()],
    ["left.d.ts", "export interface Item { a: number; }\n"],
    ["right.d.ts", "export interface Item { b: string; }\n"],
  ]);
  assert.notEqual(head[".:pair"], published[".:pair"]);
});

test("a class whose methods answer ever deeper instantiations of itself is printed once", () => {
  const surface = surfaceOf(TYPES_MANIFEST, [
    [
      "index.d.ts",
      `interface Box<T> { value: T; }\nexport declare class Stream<T> { nest(): Stream<Box<T>>; pick<K extends keyof T>(key: K): Stream<T[K]>; }\nexport declare function open(): Stream<string>;\n`,
    ],
  ]);
  assert.equal(
    surface[".:open"],
    "() => Stream<string> where class Stream<T> { nest(): Stream<Box<T>>; pick<K extends keyof T>(key: K): Stream<T[K]>; } interface Box<T> { value: T; }",
  );
});

test("a declaration reached only through a second instantiation of a generic is a changed function", () => {
  const source = (extra: string) =>
    `interface A { a: 1; }\ninterface B { b: 1;${extra} }\ninterface Foo<T> { x: T extends string ? A : B; }\nexport declare function f(s: Foo<string>, n: Foo<number>): void;\n`;
  assert.deepEqual(changedPaths(source(""), source(" extra: string;")), [
    ".:f",
  ]);
});

test("a declaration the static side of a class reaches is a changed function that takes the class and its constructor", () => {
  const source = (type: string) =>
    `interface Options { retries: ${type}; }\nexport declare class Client { constructor(options: Options); send(): void; }\nexport declare function use(client: Client, ctor: typeof Client): void;\n`;
  assert.deepEqual(changedPaths(source("number"), source("string")), [
    ".:Client",
    ".:use",
  ]);
});

test("a declaration reached through an import type in a generic is a changed function", () => {
  const surface = (extra: string) =>
    surfaceOf(TYPES_MANIFEST, [
      [
        "index.d.ts",
        `interface Box<T> { v: T extends string ? number : import("./m").B; }\ninterface Holder<T> { box: Box<T>; }\nexport declare function g(h: Holder<number>): void;\n`,
      ],
      ["m.d.ts", `export interface B { b: 1;${extra} }\n`],
    ]);
  assert.notEqual(surface("")[".:g"], surface(" extra: string;")[".:g"]);
});

test("a declaration reached through a second instantiation of an inline object type is a changed function, as is the function whose answer names it", () => {
  const source = (extra: string) =>
    `interface A { a: 1; }\ninterface B { b: 1;${extra} }\ndeclare function make<T>(x: T): { v: T extends string ? A : B };\nexport declare function h(a: ReturnType<typeof make<string>>, b: ReturnType<typeof make<number>>): void;\n`;
  assert.deepEqual(changedPaths(source(""), source(" extra: string;")), [
    ".:h",
    ".:make",
  ]);
});

test("a declaration reached through a union alias in a second instantiation of a generic is a changed function", () => {
  const source = (extra: string) =>
    `interface A { a: 1; }\ninterface B { b: 1;${extra} }\ninterface C { c: 1; }\ntype U<T> = C | (T extends string ? A : B);\ninterface Foo<T> { x: U<T>; }\nexport declare function f(s: Foo<string>, n: Foo<number>): void;\n`;
  assert.deepEqual(changedPaths(source(""), source(" extra: string;")), [
    ".:f",
  ]);
});

test("a declaration reached through an inline object type of a second instantiation is a changed function", () => {
  const source = (extra: string) =>
    `interface B { b: 1;${extra} }\ninterface G<T> { x: { v: T }; }\nexport declare function f(a: G<string>["x"], b: G<B>["x"]): void;\n`;
  assert.deepEqual(changedPaths(source(""), source(" extra: string;")), [
    ".:f",
  ]);
});

test("a declaration reached through a method of a second instantiation is a changed function", () => {
  const source = (extra: string) =>
    `interface Other { x: 1; }\ninterface IC { c: 1;${extra} }\ninterface Svc<S> { run(): Promise<S>; }\nexport declare function f(a: Svc<Other>["run"], b: Svc<IC>["run"]): void;\n`;
  assert.deepEqual(changedPaths(source(""), source(" extra: string;")), [
    ".:f",
  ]);
});

test("a protected member type is reached through the constructor of a class", () => {
  const source = (extra: string) =>
    `interface A { a: 1;${extra} }\nexport declare class C { protected p: A; static s: number; }\nexport declare function f(a: typeof C): void;\n`;
  assert.deepEqual(changedPaths(source(""), source(" extra: string;")), [
    ".:C",
    ".:f",
  ]);
});

test("a type alias whose arguments grow on every step is read, not instantiated", () => {
  const started = performance.now();
  const surface = surfaceOf(TYPES_MANIFEST, [
    [
      "index.d.ts",
      `type Nest<T> = Nest<T[]>[];\nexport declare function f(x: Nest<string>): void;\n`,
    ],
  ]);
  assert.equal(
    surface[".:f"],
    "(x: Nest<string>) => void where type Nest<T> = Nest<T[]>[];",
  );
  assert.ok(
    performance.now() - started < 10_000,
    "instantiating Nest until the checker gives up takes about 50 s",
  );
});

test("a function whose answer queries ever deeper instantiations of itself is read once", () => {
  const surface = surfaceOf(TYPES_MANIFEST, [
    [
      "index.d.ts",
      `declare function g<T>(x: T): { next(): ReturnType<typeof g<T[]>>; other(): ReturnType<typeof g<[T]>> };\nexport declare function f(x: ReturnType<typeof g<string>>): void;\n`,
    ],
  ]);
  assert.deepEqual(Object.keys(surface).sort(), [".:f", ".:g"]);
});

test("a conditional branch that would grow without end is read, not evaluated", () => {
  const surface = surfaceOf(TYPES_MANIFEST, [
    [
      "index.d.ts",
      `declare function g<T>(x: T): { next(): ReturnType<typeof g<T[]>> };\ninterface Holder<T> { value: T extends string ? number : ReturnType<typeof g<T>> }\nexport declare function f(x: Holder<string>): void;\nexport {};\n`,
    ],
  ]);
  assert.equal(
    surface[".:f"],
    "(x: Holder<string>) => void where interface Holder<T> { value: T extends string ? number : ReturnType<typeof g<T>>; }",
  );
});

const SECRET = (extra: string) => `interface Secret { s: number;${extra} }\n`;

const secretChanges = (rest: string) =>
  changedPaths(SECRET("") + rest, SECRET(" extra: string;") + rest);

test("a declaration written in an index signature of a type argument is a changed function", () => {
  assert.deepEqual(
    secretChanges(
      `interface Lookup<T> { value: T[string] }\nexport declare function f(a: Lookup<{ [key: string]: number }>, b: Lookup<{ [key: string]: Secret }>): void;\n`,
    ),
    [".:f"],
  );
});

test("a declaration written as the this parameter of a type argument is a changed function", () => {
  assert.deepEqual(
    secretChanges(
      `interface Bound<T> { receiver: ThisParameterType<T> }\nexport declare function f(a: Bound<(this: number) => void>, b: Bound<(this: Secret) => void>): void;\n`,
    ),
    [".:f"],
  );
});

test("a declaration written in a type predicate of a type argument is a changed function", () => {
  assert.deepEqual(
    secretChanges(
      `interface Guarded<T> { narrowed: T extends (value: unknown) => value is infer S ? S : never }\nexport declare function f(a: Guarded<(value: unknown) => value is string>, b: Guarded<(value: unknown) => value is Secret>): void;\n`,
    ),
    [".:f"],
  );
});

test("a type argument written only in a heritage clause is a changed function for the inherited method", () => {
  assert.deepEqual(
    secretChanges(
      `declare function c<T extends unknown[], U>(): { next: T["length"] extends 2 ? U : ReturnType<typeof c<[...T, 0], U>> };\ndeclare class Base<V> { m(): ReturnType<typeof c<[], V>> }\nexport declare class Repo extends Base<Secret> {}\nexport {};\n`,
    ),
    [".:Repo", ".:Repo.prototype.m"],
  );
});

test("an alias the checker drops from an optional parameter is a changed function", () => {
  const source = (member: string) =>
    `type Body = string | { b: ${member} };\nexport declare function f(body?: Body): void;\n`;
  assert.deepEqual(changedPaths(source("number"), source("string")), [".:f"]);
});

test("a module queried with typeof import and a member reached through a namespace are read in a declaration", () => {
  const surface = surfaceOf(TYPES_MANIFEST, [
    [
      "index.d.ts",
      `declare namespace ns { interface Pair { p: number } const pair: Pair; }\ninterface Holder { m: typeof import("./m"); a: typeof ns.pair }\nexport declare function f(h: Holder): void;\n`,
    ],
    [
      "m.d.ts",
      `export interface S { s: number }\nexport declare const v: S;\n`,
    ],
  ]);
  assert.match(
    surface[".:f"] ?? "",
    / interface Pair \{ p: number; \} interface S \{ s: number; \}$/,
  );
});

test("a value a queried module re-exports is read", () => {
  const surface = surfaceOf(TYPES_MANIFEST, [
    [
      "index.d.ts",
      `export declare function f(m: typeof import("./mod")): void;\n`,
    ],
    [
      "mod.d.ts",
      `export { helper } from "./impl";\nexport * as inner from "./impl";\n`,
    ],
    [
      "impl.d.ts",
      `export interface Secret { s: number }\nexport declare function helper(a: Secret): void;\n`,
    ],
  ]);
  assert.match(
    surface[".:f"] ?? "",
    / where interface Secret \{ s: number; \}$/,
  );
});

test("a base class passed to a mixin call in a heritage clause is a changed function", () => {
  const source = (member: string) =>
    `export declare class Base { x: ${member} }\ndeclare function mk(): typeof Base;\nexport declare class Derived extends mk() {}\nexport declare function f(a: Derived): void;\n`;
  assert.deepEqual(changedPaths(source("number"), source("string")), [
    ".:Base",
    ".:Derived",
    ".:f",
    ".:mk",
  ]);
});

test("a declaration a dependency's alias reaches through a module augmentation, once instantiated, is a changed function", () => {
  const surface = (member: string) =>
    surfaceOf(TYPES_MANIFEST, [
      [
        "index.d.ts",
        `import type { Get } from "ext";\ninterface Secret { s: ${member} }\ndeclare module "ext" { interface Registry { foo: Secret } }\ninterface Box<K extends "foo"> { v: Get<K> }\nexport declare function f(): Box<"foo">;\n`,
      ],
      ["node_modules/ext/package.json", `{"name":"ext","types":"index.d.ts"}`],
      [
        "node_modules/ext/index.d.ts",
        `export interface Registry {}\nexport type Get<K extends keyof Registry> = Registry[K];\n`,
      ],
    ]);
  assert.notEqual(surface("number")[".:f"], surface("string")[".:f"]);
});

const GROWING = `declare function c<T extends unknown[], U>(): { next: T["length"] extends 2 ? U : ReturnType<typeof c<[...T, 0], U>> };\n`;

test("a type argument written inside a heritage call is a changed function for the inherited method", () => {
  const mixins = [
    `declare function mix<V>(): { new (): { m(): ReturnType<typeof c<[], V>> } };\nexport declare class Repo extends mix<Secret>() {}\n`,
    `declare class Base<V> { m(): ReturnType<typeof c<[], V>> }\ndeclare function mix<B>(b: B): B;\nexport declare class Repo extends mix(Base<Secret>) {}\n`,
  ];
  for (const mixin of mixins)
    assert.deepEqual(secretChanges(`${GROWING}${mixin}export {};\n`), [
      ".:Repo",
      ".:Repo.prototype.m",
    ]);
});

test("a type argument a base passed to a mixin call inherits is a changed function for the inherited method", () => {
  assert.deepEqual(
    secretChanges(
      `${GROWING}declare class Root<V> { m(): ReturnType<typeof c<[], V>> }\ndeclare class Base extends Root<Secret> {}\ndeclare function mix<T extends new (...a: any[]) => any>(b: T): T;\nexport declare class Repo extends mix(Base) {}\nexport {};\n`,
    ),
    [".:Repo", ".:Repo.prototype.m"],
  );
});

test("the class a queried module assigns with export = is read", () => {
  const surface = surfaceOf(TYPES_MANIFEST, [
    [
      "index.d.ts",
      `interface Box { m: typeof import("./m") }\nexport declare function f(): Box;\n`,
    ],
    [
      "m.d.ts",
      `interface Secret { s: number }\ndeclare class Foo { get(): Secret }\nexport = Foo;\n`,
    ],
  ]);
  assert.match(surface[".:f"] ?? "", / class Foo \{ get\(\): Secret; \} /);
});

test("a global only the package declares is a changed function when a dependency reads it", () => {
  const surface = (member: string) =>
    surfaceOf(TYPES_MANIFEST, [
      [
        "index.d.ts",
        `import type { Get } from "ext";\ninterface Secret { s: ${member} }\ndeclare global { interface Reg { foo: Secret } }\ninterface Box<K extends "foo"> { v: Get<K> }\nexport declare function f(): Box<"foo">;\n`,
      ],
      ["node_modules/ext/package.json", `{"name":"ext","types":"index.d.ts"}`],
      [
        "node_modules/ext/index.d.ts",
        `export type Get<K extends keyof Reg> = Reg[K];\n`,
      ],
    ]);
  assert.notEqual(surface("number")[".:f"], surface("string")[".:f"]);
});

test("an augmented lib interface prints the package's declaration, not lib's", () => {
  const surface = surfaceOf(TYPES_MANIFEST, [
    [
      "index.d.ts",
      `interface Secret { s: number }\ndeclare global { interface Array<T> { secret: Secret } }\nexport declare function f(a: number): string;\n`,
    ],
  ]);
  assert.equal(
    surface[".:f"],
    "(a: number) => string where interface Array<T> { secret: Secret; } interface Secret { s: number; }",
  );
});

test("a type argument written in a base variable's type is a changed function for the inherited method", () => {
  assert.deepEqual(
    secretChanges(
      `${GROWING}declare function mix<V>(): { new (): { m(): ReturnType<typeof c<[], V>> } };\ndeclare const Repo_base: ReturnType<typeof mix<Secret>>;\nexport declare class Repo extends Repo_base {}\nexport {};\n`,
    ),
    [".:Repo", ".:Repo.prototype.m"],
  );
});
