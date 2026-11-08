import { RuleTester } from "oxlint/plugins-dev";

import { requireSafetyCommentForTypeAssertionRule } from "./require-safety-comment-for-type-assertion.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });
const error = { messageId: "missingSafetyComment" };

tester.run(
  "anti-slop/require-safety-comment-for-type-assertion (custom markers)",
  requireSafetyCommentForTypeAssertionRule,
  {
    valid: [
      {
        code: "// INVARIANT: The caller parsed this value.\nconst value = input as User;",
        options: [{ markers: ["INVARIANT"] }],
      },
      {
        code: "// SAFETY: The caller parsed this value.\nconst value = input as User;",
        options: [{ markers: ["INVARIANT", "SAFETY"] }],
      },
      {
        code: "// SAFE+: The caller parsed this value.\nconst value = input as User;",
        options: [{ markers: ["SAFE+"] }],
      },
    ],
    invalid: [
      {
        code: "// SAFETY: This marker is not configured.\nconst value = input as User;",
        options: [{ markers: ["INVARIANT"] }],
        errors: [error],
      },
      {
        code: "// INVARIANT:   \nconst value = input as User;",
        options: [{ markers: ["INVARIANT"] }],
        errors: [error],
      },
    ],
  },
);

tester.run(
  "anti-slop/require-safety-comment-for-type-assertion",
  requireSafetyCommentForTypeAssertionRule,
  {
    valid: [
      "const values = [1, 2] as const;",
      "const value = <const>{ id: 'one' };",
      "// SAFETY: The parser established the UserId invariant.\nconst id = value as UserId;",
      "function parse(): UserId {\n// SAFETY: Validation above established the UserId invariant.\nreturn value as UserId;\n}",
      "const id = /* SAFETY: Validation established the invariant. */ value as UserId;",
      "// SAFETY: The parser established the exported UserId invariant.\nexport const id = value as UserId;",
      "/* SAFETY:\n * The parser established the exported UserId invariant.\n */\nexport const id = value as UserId;",
    ],
    invalid: [
      { code: "const id = value as UserId;", errors: [error] },
      { code: "const id = <UserId>value;", errors: [error] },
      { code: "const id = value as UserId; // SAFETY: Too late.", errors: [error] },
      {
        code: "// This cast seems fine.\nconst id = value as UserId;",
        errors: [error],
      },
      { code: "// SAFETY:\nconst id = value as UserId;", errors: [error] },
      { code: "// SAFETY:   \nconst id = value as UserId;", errors: [error] },
      { code: "const id = /* SAFETY: */ value as UserId;", errors: [error] },
      { code: "export const id = value as UserId;", errors: [error] },
      {
        code: "// This is not a safety justification.\nexport const id = value as UserId;",
        errors: [error],
      },
    ],
  },
);

const jsTester = new RuleTester();

jsTester.run(
  "anti-slop/require-safety-comment-for-type-assertion (JSDoc casts)",
  requireSafetyCommentForTypeAssertionRule,
  {
    valid: [
      {
        name: "agent-skills scripts/lib/*.mjs JSDoc cast with its SAFETY comment",
        filename: "values.mjs",
        code: "// SAFETY: JSON.parse of a manifest the loader validated.\nconst manifest = /** @type {Manifest} */ (JSON.parse(text));",
      },
      {
        filename: "values.js",
        code: "const id = /* SAFETY: Validation established the invariant. */ /** @type {UserId} */ (value);",
      },
      {
        filename: "values.cjs",
        code: "function parse() {\n// SAFETY: Validation above established the UserId invariant.\nreturn /** @type {UserId} */ (value);\n}",
      },
      { filename: "values.mjs", code: "const values = /** @type {const} */ ([1, 2]);" },
      { filename: "values.mjs", code: "/** @type {UserId} */\nconst id = value;" },
      { filename: "values.mjs", code: "const id = /** @satisfies {UserId} */ (value);" },
      { filename: "values.mjs", code: "const id = /* @type {UserId} */ (value);" },
      { filename: "values.ts", code: "const id = /** @type {UserId} */ (value);" },
      {
        name: "a JSDoc type on an arrow function annotates it, it does not cast",
        filename: "handlers.js",
        code: "const handler = /** @type {Handler} */ (request, response) => response.end();\nitems.map(/** @type {Mapper} */ (item) => item);",
      },
    ],
    invalid: [
      {
        name: "agent-skills#28 bare JSDoc cast in an .mjs file",
        filename: "values.mjs",
        code: "const manifest = /** @type {Manifest} */ (JSON.parse(text));",
        errors: [error],
      },
      {
        filename: "values.js",
        code: "export const id = /** @type {UserId} */ (value);",
        errors: [error],
      },
      {
        filename: "values.cjs",
        code: "function parse() {\nreturn /** @type {UserId} */ (value);\n}",
        errors: [error],
      },
      {
        name: "a parenthesized arrow function after a JSDoc type is a cast",
        filename: "handlers.js",
        code: "const handler = /** @type {Handler} */ ((request) => request);",
        errors: [error],
      },
      {
        filename: "values.mjs",
        code: "const name = /** @type {User} */ (value).name;",
        errors: [error],
      },
      {
        filename: "values.mjs",
        code: "use(/** @type {UserId} */ (first), /** @type {UserId} */ (second));",
        errors: [error, error],
      },
      {
        filename: "values.mjs",
        code: "// SAFETY:\nconst id = /** @type {UserId} */ (value);",
        errors: [error],
      },
      {
        filename: "values.mjs",
        code: "const id = /** @type {UserId} SAFETY: inside the cast. */ (value);",
        errors: [error],
      },
    ],
  },
);
