import { RuleTester } from "oxlint/plugins-dev";

import { noCommentsRule } from "./no-comments.ts";

const tester = new RuleTester({
  languageOptions: { parserOptions: { lang: "ts" } },
});
const error = { messageId: "comment" };
const detached = { messageId: "detachedDoc" };

tester.run("antelopejs/no-comments", noCommentsRule, {
  valid: [
    "/** Public API documentation. */ export function run() {}",
    "// oxlint-disable-next-line no-debugger\ndebugger;",
    "/* eslint-enable no-alert */",
    "// @ts-expect-error: the external API is deliberately invalid\nrun(1);",
    "/* @ts-expect-error third-party declaration has the wrong return type */\nrun();",
    "// SAFETY: the caller holds the lock\nrun();",
    "/* SAFETY: bounds were checked at the boundary. */ run();",
    "/* SAFETY: the caller holds the lock.\n * The write stays inside the critical section.\n */ run();",
    "// SAFETY: the caller holds the lock.\n// The write stays inside the critical section.\n// Unlock only after the write.\nrun();",
    "/*\n * SAFETY: the caller holds the lock.\n */ run();",
    "/*! Copyright 2026 AntelopeJS. Licensed under Apache-2.0. */",
    "/* #__PURE__ */ build();",
    "/* @__PURE__ */ build();",
    "// prettier-ignore\nrun();",
    "/* oxfmt-ignore */ run();",
    "import(/* @vite-ignore */ path);",
    ...[
      'webpackChunkName: "chunk"',
      "webpackPrefetch: true",
      "webpackPreload: true",
      'webpackMode: "lazy"',
      "webpackIgnore: true",
      'webpackExports: ["default"]',
      "webpackInclude: /include/",
      "webpackExclude: /exclude/",
    ].map((directive) => `import(/* ${directive} */ path);`),
    '/// <reference types="node" />',
    '/// <reference path="./public.d.ts" />',
    'const url = "https://example.com";',
    "#!/usr/bin/env node\nrun();",
    "/** @internal @packageDocumentation */\nexport {};",
    "/** @module */\nimport { a } from './a';",
    "/** SAFETY: the caller holds the lock. */ run();",
    "/** @__PURE__ */ build();",
    "/*! Licensed under Apache-2.0. */ function run() { /*! kept anywhere */ }",
    ...[
      ["a function", "/** Runs. */ function run() {}"],
      ["an exported function", "/** Runs. */ export function run() {}"],
      ["a class", "/** A thing. */ class A {}"],
      ["a decorated class", "/** A thing. */ @Injectable() class A {}"],
      [
        "an exported decorated class",
        "/** A thing. */ @Injectable() export class A {}",
      ],
      ["a method", "class A {\n  /** Runs. */\n  run() {}\n}"],
      ["a class property", "class A {\n  /** The id. */\n  id = 1;\n}"],
      [
        "a decorated class property",
        "class A {\n  /** The id. */\n  @Prop() id = 1;\n}",
      ],
      [
        "a constructor parameter property",
        "class A {\n  constructor(/** The id. */ private id: number) {}\n}",
      ],
      [
        "an interface member",
        "interface A {\n  /** The id. */\n  id: number;\n  /** Runs. */\n  run(): void;\n}",
      ],
      ["a type alias", "/** An id. */ type Id = number;"],
      ["an enum member", "enum A {\n  /** First. */\n  One,\n}"],
      [
        "an object literal property",
        "const a = {\n  /** The id. */\n  id: 1,\n};",
      ],
      ["a default export", "/** The default. */ export default function () {}"],
      [
        "a namespace re-export",
        "/** The helpers. */ export * as helpers from './helpers';",
      ],
      [
        "a member of a nested declared module",
        "declare module 'a' {\n  /** Runs. */\n  function run(): void;\n  namespace B {\n    /** The id. */\n    const id: number;\n  }\n}",
      ],
    ].map(([name, code]) => ({
      name: `a rule that rejects TSDoc on ${name}`,
      code,
    })),
    {
      name: "a rule that accepts only TSDoc without JSDoc tags would reject a typedef in a script",
      filename: "types.mjs",
      code: "/** @typedef {{ id: number }} Foo */\nexport const a = 1;",
    },
    {
      name: "a rule that has no JavaScript cast case rejects the block the SAFETY rule justifies",
      filename: "cast.mjs",
      code: "// SAFETY: validated above.\nconst a = /** @type {X} */ (y);",
    },
  ],
  invalid: [
    {
      name: "interface-core@5735668:oxfmt.config.ts:4",
      code: "// Drop once tooling-configs ships the shared ignore (AntelopeJS/tooling-configs#5):",
      errors: [error],
    },
    { code: "// ordinary explanation\nrun();", errors: [error] },
    { code: "/* ordinary explanation */ run();", errors: [error] },
    {
      code: "/*\n * ordinary multi-line explanation\n */ run();",
      errors: [error],
    },
    { code: "/* * decorated explanation */ run();", errors: [error] },
    { code: "// @ts-expect-error\nrun();", errors: [error] },
    { code: "// @ts-expect-error: \nrun();", errors: [error] },
    { code: "// oxlint-disablement is not a directive", errors: [error] },
    { code: "// The word SAFETY: is not a prefix", errors: [error] },
    { code: "// <reference types='node' />", errors: [error] },
    { code: "/* / <reference types='node' /> */", errors: [error] },
    { code: "// first\n/* second */", errors: [error, error] },
    ...["eslint", "oxlint"].flatMap((tool) =>
      ["disable", "disable-line", "disable-next-line"].flatMap((directive) => [
        {
          code: `// ${tool}-${directive}\nrun();`,
          errors: [{ messageId: "unnamedDisable" }],
        },
        {
          code: `/* ${tool}-${directive} -- no rule named */ run();`,
          errors: [{ messageId: "unnamedDisable" }],
        },
      ]),
    ),
    {
      code: "// SAFETY: checked\n\n// ordinary explanation\nrun();",
      errors: [error],
    },
    {
      code: "// SAFETY: checked\nrun();\n// ordinary explanation",
      errors: [error],
    },
    {
      code: "// SAFETY: checked\n/* ordinary explanation */",
      errors: [error],
    },
    {
      code: "// SAFETY: checked\n// oxlint-disable\nrun();",
      errors: [{ messageId: "unnamedDisable" }],
    },
    {
      name: "a rule that accepts `/**` anywhere accepts TSDoc before a local const",
      code: "function run() {\n  /** The id. */\n  const id = 1;\n  return id;\n}",
      errors: [detached],
    },
    {
      name: "a rule that accepts `/**` anywhere accepts it before an expression statement",
      code: "/** Runs it. */ run();",
      errors: [detached],
    },
    {
      name: "a rule that accepts `/**` anywhere accepts it at the end of the file",
      code: "export const a = 1;\n/** Trailing. */",
      errors: [detached],
    },
    {
      name: "a rule that accepts `/**` anywhere accepts it before an import",
      code: "/** The module. */\nimport { a } from './a';",
      errors: [detached],
    },
    {
      name: "a rule that attaches a block to any ancestor accepts it before a function expression inside a call",
      code: "export const a = register(/** Handles it. */ function () {});",
      errors: [detached],
    },
    {
      name: "a rule that accepts a declaration nested in a function body reports it only at module level",
      code: "function run() {\n  /** A local type. */\n  type Id = number;\n  /** A local function. */\n  function inner() {}\n}",
      errors: [detached, detached],
    },
    {
      name: "a rule that accepts a module tag anywhere accepts it after code",
      code: "export const a = 1;\n/** @packageDocumentation */",
      errors: [detached],
    },
    {
      name: "a rule that treats `/**` before `(` as a cast in TypeScript accepts it",
      code: "const a = /** @type {X} */ (y);",
      errors: [detached],
    },
    {
      name: "a rule that treats `/*` as TSDoc reports an ordinary block under the comment message",
      code: "/* The id. */ export const a = 1;",
      errors: [error],
    },
    {
      name: "a rule that drops the unnamed-disable check for TSDoc accepts a bare directive in a detached block",
      code: "/** eslint-disable */ run();",
      errors: [{ messageId: "unnamedDisable" }],
    },
    {
      name: "a rule that keeps the old `[*!]` block form accepts prose in `/**` before a statement",
      code: "/** ordinary */ run();",
      errors: [detached],
    },
  ],
});

const jsTester = new RuleTester();

jsTester.run("antelopejs/no-comments (JavaScript files)", noCommentsRule, {
  valid: [
    {
      name: "a rule that rejects a JSDoc cast reports the block the SAFETY rule justifies",
      filename: "cast.mjs",
      code: "const a = /** @type {X} */ (y);",
    },
    {
      name: "a rule that rejects an arrow annotation reports the block the SAFETY rule skips",
      filename: "arrow.js",
      code: "const a = /** @type {Handler} */ (request) => request;",
    },
    {
      name: "a rule that rejects a standalone typedef inside a function body",
      filename: "types.cjs",
      code: "function run() {\n  /** @typedef {{ id: number }} Foo */\n  return 1;\n}",
    },
    {
      name: "a rule that rejects a callback typedef",
      filename: "types.mjs",
      code: "/** @callback Handler\n * @param {string} name\n */\nrun();",
    },
    {
      name: "a rule that rejects a JSDoc import",
      filename: "types.mjs",
      code: "/** @import { Foo } from './foo.js' */\nrun();",
    },
    ...[
      [
        "`@type` on `module.exports`",
        "config.cjs",
        "/** @type {import('x').Config} */\nmodule.exports = { a: 1 };",
      ],
      [
        "`@type` on a local const",
        "map.mjs",
        "export function f() {\n  /** @type {Map<string, number>} */\n  const m = new Map();\n  return m;\n}",
      ],
      [
        "`@param` on a local function",
        "local.js",
        "export function f() {\n  /** @param {string} a */\n  function g(a) {}\n  return g;\n}",
      ],
      [
        "`@type` on a `this` property",
        "class.js",
        "class A {\n  constructor() {\n    /** @type {number} */\n    this.x = 1;\n  }\n}",
      ],
    ].map(([name, filename, code]) => ({
      name: `a rule that reads only declarations rejects JavaScript's type system, ${name}`,
      filename,
      code,
    })),
  ],
  invalid: [
    {
      name: "a rule that allows the JavaScript forms in every file accepts a typedef in a TypeScript file",
      filename: "types.ts",
      code: "run();\n/** @typedef {{ id: number }} Foo */\nrun();",
      errors: [detached],
    },
    {
      name: "a rule that accepts any detached block in a script accepts prose before a call",
      filename: "plain.mjs",
      code: "/** Runs it. */\nrun();",
      errors: [detached],
    },
    {
      name: "a rule that accepts any `/**` in a script accepts prose before a local const",
      filename: "local.mjs",
      code: "export function f() {\n  /** The id. */\n  const id = 1;\n  return id;\n}",
      errors: [detached],
    },
    {
      name: "a rule that treats any `/**` before `(` as a cast in a script accepts prose there",
      filename: "paren.mjs",
      code: "export const a = /** The value. */ (y);",
      errors: [detached],
    },
  ],
});
