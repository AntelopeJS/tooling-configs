import { RuleTester } from "oxlint/plugins-dev";

import { noConstantValueAssertionRule } from "./no-constant-value-assertion.ts";

const tester = new RuleTester({
  languageOptions: { parserOptions: { lang: "ts" } },
});
const error = { messageId: "constant" };

tester.run(
  "antelopejs/no-constant-value-assertion",
  noConstantValueAssertionRule,
  {
    valid: [
      "expect(getLimit()).toBe(5);",
      "expect(limit).toBe(5);",
      "expect(LIMIT).toBe(config.limit);",
      "expect(Limits.maxItems).toBe(5);",
      'expect(process.env.NODE_ENV).toBe("test");',
      "expect(user.ID).toBe(7);",
      "expect(Limits.MAX_ITEMS).toBe(5);",
      'expect(config["MAX_ITEMS"]).toBe(5);',
      "expect(MAX_ITEMS).toBe(getLimit());",
      "expect(MAX_ITEMS).not.toBe(5);",
      "expect(MAX_ITEMS).toBe(`${getLimit()}`);",
      "expect(MAX_ITEMS).toEqual([other]);",
      "expect(MAX_ITEMS).toEqual({ value: other });",
      "expect(MAX_ITEMS).toEqual({ [key]: 5 });",
      "expect(MAX_ITEMS).toEqual({ ...other });",
      "expect(MAX_ITEMS).toEqual({ get value() { return 5; } });",
      "expect(MAX_ITEMS).toBe(/five/);",
    ],
    invalid: [
      {
        name: "antelopejs@b0c06d3:test/core/cli/core-version.test.ts:16",
        code: 'expect(CORE_PACKAGE_NAME).to.equal("@antelopejs/core");',
        errors: [error],
      },
      {
        name: "dms-saas@6303799:packages/dms-saas/test/stripe-payload-shapes.test.ts:42",
        code: 'expect(STRIPE_API_VERSION).toBe("2026-08-26.dahlia");',
        errors: [error],
      },
      ...[
        "toBe",
        "toEqual",
        "toStrictEqual",
        "to.equal",
        "to.eq",
        "eql",
        "to.eql",
        "to.deep.eq",
        "to.deep.equal",
        "to.be.equal",
      ].map((matcher) => ({
        code: `expect(MAX_ITEMS).${matcher}(5);`,
        errors: [error],
      })),
      ...[
        "true",
        "null",
        "`fixed`",
        "-5",
        '[1, "two", false, null, -3]',
        '{ a: [1, { b: "two" }] }',
      ].map((value) => ({
        code: `expect(CONSTANT).toEqual(${value});`,
        errors: [error],
      })),
      {
        code: 'expect(BLOCK_COMPONENT_NAMES.if).toBe("MailingEditorIfBlock");',
        errors: [error],
      },
      {
        code: "expect(CONSTANT.nested.value).toEqual({ a: 2 });",
        errors: [error],
      },
      { code: 'expect(CONSTANT["value"]).toBe(5);', errors: [error] },
    ],
  },
);
