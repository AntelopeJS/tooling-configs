import { RuleTester } from "oxlint/plugins-dev";

import { propertyTestTimeoutRule } from "./property-test-timeout.ts";

const tester = new RuleTester({
  languageOptions: { parserOptions: { lang: "ts" } },
});
const timed = (timer: string) => ({
  messageId: "timed",
  data: { timer },
});

tester.run("antelopejs/property-test-timeout", propertyTestTimeoutRule, {
  valid: [
    {
      name: "antelopejs@eeb0d32:test/core/cli/config-writes-are-oxfmt-fixpoints.property.test.ts:77",
      code: `describe("CLI writers emit what oxfmt keeps", () => {
  it("writeConfig output is an oxfmt fixpoint", async function () {
    this.timeout(0);
    await fc.assert(fc.asyncProperty(moduleMap, check));
  });
});`,
    },
    {
      name: "antelopejs@eeb0d32:test/core/module-manager.interface-ranges.test.ts:94",
      code: `describe("ModuleManager interface range properties", function () {
  this.timeout(0);
  it("matches semver", async () => {
    await fc.assert(fc.asyncProperty(range, check));
  });
});`,
    },
    {
      name: "api@5a93751:src/test/formal-route-tree.test.ts:24",
      code: `describe("Route tree against a Map-based reference router", () => {
  it("registers, matches and unregisters like the reference", async function () {
    this.timeout(0);
    const outcome = await fc.check(fc.asyncProperty(scenarioArbitrary(), runScenario), { numRuns: RUNS });
    assert.equal(outcome.failed, false);
  });
});`,
    },
    'it("adds", async function () { this.timeout(60000); await add(1, 2); });',
    'describe("outer", function () { this.timeout(0); describe("inner", () => { it("holds", () => { fc.assert(property); }); }); });',
    'it("holds", function () { this.timeout(0); const run = () => fc.assert(property); run(); });',
    'it.skip("holds", () => { fc.assert(property); });',
    'import { it } from "vitest"; it("holds", () => { fc.assert(property); });',
    'import { test } from "node:test"; test("holds", () => { fc.assert(property); });',
    'describe("setup", () => { fc.assert(property); });',
  ],
  invalid: [
    {
      name: "antelopejs@eeb0d32^:test/core/cli/config-writes-are-oxfmt-fixpoints.property.test.ts:77",
      code: `describe("CLI writers emit what oxfmt keeps", () => {
  it("writeConfig output is an oxfmt fixpoint", async function () {
    this.timeout(60000);
    await fc.assert(fc.asyncProperty(moduleMap, check));
  });
});`,
      errors: [timed("60000")],
    },
    {
      name: "antelopejs@eeb0d32^:test/core/module-manager.interface-ranges.test.ts:94",
      code: `describe("ModuleManager interface range properties", function () {
  this.timeout(60000);
  it("matches semver", async () => {
    await fc.assert(fc.asyncProperty(range, check));
  });
});`,
      errors: [timed("60000")],
    },
    {
      name: "api@5a93751^:src/test/formal-route-tree.test.ts:24",
      code: `describe("Route tree against a Map-based reference router", () => {
  it("registers, matches and unregisters like the reference", async function () {
    this.timeout(Math.max(MIN_TIMEOUT_MS, RUNS * MS_PER_RUN));
    const outcome = await fc.check(fc.asyncProperty(scenarioArbitrary(), runScenario), { numRuns: RUNS });
    assert.equal(outcome.failed, false);
  });
});`,
      errors: [timed("Math.max(MIN_TIMEOUT_MS, RUNS * MS_PER_RUN)")],
    },
    {
      name: "a test with no timeout runs on the default",
      code: 'it("holds", () => { fc.assert(property); });',
      errors: [timed("the default")],
    },
    {
      name: "the nearest describe that sets a timeout decides",
      code: 'describe("outer", function () { this.timeout(0); describe("inner", function () { this.timeout(5000); it("holds", () => { fc.assert(property); }); }); });',
      errors: [timed("5000")],
    },
    {
      name: "the test's own timeout overrides its describe",
      code: 'describe("outer", function () { this.timeout(0); it("holds", function () { this.timeout(2000); fc.assert(property); }); });',
      errors: [timed("2000")],
    },
    {
      name: "a timeout a nested function sets is that function's",
      code: 'it("holds", async () => { const helper = function () { this.timeout(0); }; helper(); await fc.assert(property); });',
      errors: [timed("the default")],
    },
    {
      name: "an arrow describe cannot set a timeout",
      code: 'describe("outer", function () { this.timeout(1000); describe("inner", () => { it("holds", () => { fc.assert(property); }); }); });',
      errors: [timed("1000")],
    },
  ],
});
