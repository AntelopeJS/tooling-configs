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

tester.run(
  "anti-slop/require-safety-comment-for-type-assertion (non-null assertions)",
  requireSafetyCommentForTypeAssertionRule,
  {
    valid: [
      {
        name: "a rule that ignores the SAFETY line above a non-null assertion rejects a justified one",
        code: "// SAFETY: The map was filled for every key above.\nconst a = b!;",
      },
      {
        name: "a rule that demands one comment per `!` rejects a chain justified once at its statement",
        code: "// SAFETY: Every link was checked by the parser above.\nconst c = a!.b!.c;",
      },
      "const a = b ?? fallback;",
    ],
    invalid: [
      {
        name: "a rule that ignores TSNonNullExpression accepts a bare non-null assertion",
        code: "const a = b!;",
        errors: [error],
      },
      {
        name: "a rule that reports a chain once, not per assertion, misses the second `!`",
        code: "const c = a!.b!.c;",
        errors: [error, error],
      },
      {
        name: "a rule that treats the `as const` around a non-null assertion as the const exemption skips it",
        code: "const d = e! as const;",
        errors: [error],
      },
      {
        name: "a rule that takes any earlier comment as the justification accepts an unrelated one",
        code: "// The lookup cannot fail.\nconst a = b!;",
        errors: [error],
      },
    ],
  },
);

tester.run(
  "anti-slop/require-safety-comment-for-type-assertion (innermost statement)",
  requireSafetyCommentForTypeAssertionRule,
  {
    valid: [
      {
        name: "a rule that stops before the if statement rejects a SAFETY line above an if whose test asserts",
        code: "// SAFETY: The parser returned a boolean.\nif (flag as boolean) run();",
      },
      {
        name: "a rule that stops before the loop rejects a SAFETY line above a for-of whose iterable asserts",
        code: "// SAFETY: The parser returned an array.\nfor (const item of items as Item[]) use(item);",
      },
      {
        name: "a rule that stops before the loop rejects a SAFETY line above a while whose test asserts",
        code: "// SAFETY: The queue holds a head while it is non-empty.\nwhile (queue.head!.next) queue.shift();",
      },
      {
        name: "a rule that ignores comments inside the statement rejects a SAFETY line before an object property",
        code: "const user = {\n// SAFETY: The parser established the UserId invariant.\nid: value as UserId,\n};",
      },
      {
        name: "a rule that skips the export wrapper rejects a SAFETY line above an exported function whose default asserts",
        code: "// SAFETY: Every caller passes a parsed id.\nexport function load(id = value as UserId) {}",
      },
      {
        name: "a rule that skips the default export wrapper rejects a SAFETY line above an exported default class whose heritage asserts",
        code: "// SAFETY: The registry holds a class here.\nexport default class Parser extends (Base as Constructor) {}",
      },
    ],
    invalid: [
      {
        name: "a rule that walks past the inner for-of accepts a SAFETY line above the enclosing if",
        code: "// SAFETY: The parser returned an array.\nif (ready) {\nfor (const item of items as Item[]) use(item);\n}",
        errors: [error],
      },
      {
        name: "a rule that walks past the inner if accepts a SAFETY line above the enclosing function",
        code: "// SAFETY: The function validates its input.\nfunction parse() {\nif (flag as boolean) run();\n}",
        errors: [error],
      },
      {
        name: "a rule that walks past the method accepts a SAFETY line above the enclosing class",
        code: "// SAFETY: The class validates its input.\nclass Parser {\nparse(id = value as UserId) {}\n}",
        errors: [error],
      },
      {
        name: "a rule that walks past the inner while accepts a SAFETY line above the enclosing block",
        code: "// SAFETY: The queue is never empty here.\n{\nwhile (queue.head!.next) queue.shift();\n}",
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
        code: "const manifest = /** @type {Manifest} */ (\n  JSON.parse(text)\n);",
        errors: [{ ...error, line: 1, column: 17, endLine: 1, endColumn: 42 }],
      },
      {
        name: "two JSDoc types before one parenthesis are one cast",
        filename: "values.mjs",
        code: "const id = /** @type {Raw} */ /** @type {UserId} */ (value);",
        errors: [error],
      },
      {
        name: "a SAFETY comment above the enclosing function does not cover a cast in its body",
        filename: "values.mjs",
        code: "// SAFETY: The function validates its input.\nfunction parse() {\nreturn /** @type {UserId} */ (value);\n}",
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
