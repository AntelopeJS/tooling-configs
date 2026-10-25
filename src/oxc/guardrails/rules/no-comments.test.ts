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
  ],
});
