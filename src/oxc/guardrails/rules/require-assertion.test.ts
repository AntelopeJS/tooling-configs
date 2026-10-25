import { RuleTester } from "oxlint/plugins-dev";

import { requireAssertionRule } from "./require-assertion.ts";

const tester = new RuleTester({
  languageOptions: { parserOptions: { lang: "ts" } },
});
const error = { messageId: "missingAssertion" };

tester.run("antelopejs/require-assertion", requireAssertionRule, {
  valid: [
    ...[
      "expect(value).to.equal(1)",
      "expectFailure(run)",
      "assert(value)",
      "assert.equal(value, 1)",
      "assertRetryable(run())",
      "sinon.assert.calledOnce(spy)",
      'request(app).get("/").expect(200)',
      "client.expect(200)",
      "value.should.equal(1)",
      "value.should.be.ok",
      "should(value).equal(1)",
    ].map((assertion) => `it("asserts", () => { ${assertion}; });`),
    'it.skip("pending", () => { run(); });',
    'test.concurrent.skip("pending", () => {});',
    'test.todo("pending", () => {});',
    'it("pending");',
    'it("external callback", run);',
    'it("asserts later", () => { return promise.then(() => expect(value).toBe(1)); });',
    'describe("suite", () => { run(); });',
  ],
  invalid: [
    {
      name: "antelopejs@b0c06d3:test/core/cli/git-operations.test.ts:9-16",
      code: `it("exposes the git helper functions", async () => {
    await Promise.all([
      Promise.resolve(copyTemplate),
      Promise.resolve(loadManifestFromGit),
      Promise.resolve(loadInterfaceFromGit),
      Promise.resolve(loadInterfacesFromGit),
    ]);
  });`,
      errors: [error],
    },
    {
      name: "interface-core@5735668:src/tests/stub-mode.test.ts:71-74",
      code: `it("still queues registration when stub mode is off", () => {
      const proxy = new RegisteringProxy<(id: string) => void>();
      proxy.register("id1");
    });`,
      errors: [error],
    },
    ...["it", "test", "it.only", "test.concurrent", "test.concurrent.only"].map(
      (name) => ({
        code: `${name}("missing", () => { run(); });`,
        errors: [error],
      }),
    ),
    {
      code: 'it("outside", () => {}); expect(value).toBe(1);',
      errors: [error],
    },
    {
      code: 'it(expect(title).toBe("title"), () => {});',
      errors: [error],
    },
    {
      code: 'it("first", () => { expect(value).toBe(1); }); it("second", () => {});',
      errors: [error],
    },
  ],
});
