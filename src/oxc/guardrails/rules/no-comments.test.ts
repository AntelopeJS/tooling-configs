import { RuleTester } from "oxlint/plugins-dev";

import { noCommentsRule } from "./no-comments.ts";

const tester = new RuleTester({
  languageOptions: { parserOptions: { lang: "ts" } },
});
const error = { messageId: "comment" };

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
  ],
  invalid: [
    {
      name: "interface-core@5735668:oxfmt.config.ts:4",
      code: "// Drop once tooling-configs ships the shared ignore (AntelopeJS/tooling-configs#5):",
      errors: [error],
    },
    { code: "// ordinary explanation\nrun();", errors: [error] },
    { code: "/* ordinary explanation */ run();", errors: [error] },
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
  ],
});
