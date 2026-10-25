import { RuleTester } from "oxlint/plugins-dev";

import { noTypeofFunctionOnlyTestRule } from "./no-typeof-function-only-test.ts";

const tester = new RuleTester({
  languageOptions: { parserOptions: { lang: "ts" } },
});
const error = { messageId: "functionOnly" };

tester.run(
  "antelopejs/no-typeof-function-only-test",
  noTypeofFunctionOnlyTestRule,
  {
    valid: [
      'it("returns a value", () => { expect(fn).toBeTypeOf("function"); expect(fn()).toBe(3); });',
      'it("is empty", () => {});',
      'it("checks a string", () => { expect(value).toBeTypeOf("string"); });',
      'it("uses a helper", () => { expect(fn).toBeTypeOf("function"); expectFailure(fn); });',
      'it("uses an assert helper", () => { assert.isFunction(fn); assertRetryable(run()); });',
      'it("calls a function", () => { expect(fn()).toBe("function"); });',
      'expect(fn).toBeTypeOf("function");',
      `it("restricts copying, resending and revoking invitations to platform owners", () => {
    expect(SaasWorkspaceInvitationsController).toBeTypeOf("function");
    expect([...new Set(ownerAuthorization.methods)].sort()).toEqual([
      "copyLink",
      "resend",
      "revoke",
    ]);
  });`,
    ],
    invalid: [
      {
        name: "postgres@91e1ead:src/test/unit/expression-stages.spec.ts:80",
        code: `it("binds every stage to a callable handler", () => {
    for (const name of VOCABULARY) {
      expect(STAGES[name], name).to.be.a("function");
    }
  });`,
        errors: [error],
      },
      {
        name: "antelopejs@58035fc:test/core/cli/git-operations.test.ts:5",
        code: `it('should expose git operations', () => {
    const ops = new GitOperations();
    expect(ops.loadManifestFromGit).to.be.a('function');
    expect(ops.createAjsSymlinks).to.be.a('function');
  });`,
        errors: [error],
      },
      ...[
        'expect(fn).toBeTypeOf("function")',
        'expect(fn).to.be.a("function")',
        'expect(fn).to.be.an("function")',
        'expect(typeof fn).toBe("function")',
        'expect(typeof fn).to.equal("function")',
        "assert.isFunction(fn)",
        'assert.equal(typeof fn, "function")',
        'assert.strictEqual(typeof fn, "function")',
      ].map((assertion) => ({
        code: `test.concurrent.only("exists", () => { ${assertion}; });`,
        errors: [error],
      })),
      {
        code: 'it("exists", () => { assert.isFunction(a); assert.isFunction(b); });',
        errors: [error],
      },
      {
        code: 'it("exists", () => { for (const fn of fns) expect(fn).to.be.a("function"); });',
        errors: [error],
      },
    ],
  },
);
