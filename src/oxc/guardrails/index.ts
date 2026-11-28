import { eslintCompatPlugin } from "@oxlint/plugins";

import { withRuleDocs } from "../rule-docs.ts";

import { noCommentsRule } from "./rules/no-comments.ts";
import { noConstantValueAssertionRule } from "./rules/no-constant-value-assertion.ts";
import { noFsReadInTestsRule } from "./rules/no-fs-read-in-tests.ts";
import { noInheritedKeyLookupRule } from "./rules/no-inherited-key-lookup.ts";
import { noInterfaceInstanceofRule } from "./rules/no-interface-instanceof.ts";
import { noPresenceOnlyTypeGuardRule } from "./rules/no-presence-only-type-guard.ts";
import { noReadThenInsertRule } from "./rules/no-read-then-insert.ts";
import { noSelfImportInTestsRule } from "./rules/no-self-import-in-tests.ts";
import { noTypeofFunctionOnlyTestRule } from "./rules/no-typeof-function-only-test.ts";
import { noUnrunQueryRule } from "./rules/no-unrun-query.ts";
import { noUnsafeObjectAssignRule } from "./rules/no-unsafe-object-assign.ts";
import { propertyTestTimeoutRule } from "./rules/property-test-timeout.ts";
import { refusalKeyInLocalesRule } from "./rules/refusal-key-in-locales.ts";
import { refusalMessageIsKeyRule } from "./rules/refusal-message-is-key.ts";
import { requireAssertionRule } from "./rules/require-assertion.ts";
import { requireTsconfigIncludeRule } from "./rules/require-tsconfig-include.ts";
import { requireTsconfigTypesRule } from "./rules/require-tsconfig-types.ts";
import { sharedTestTimeoutRule } from "./rules/shared-test-timeout.ts";

export { ASSERTION_FUNCTION_NAMES, TEST_FILE_GLOBS } from "./shared.ts";

/** AntelopeJS rules that reject comments, inherited-key lookups, instanceof against an interface package class, presence-only type guards, 4xx refusals whose message is a sentence or a key no locale file holds, inserts that follow a read of the same table or that a called function makes once an awaited read found nothing, unrun interface-database queries an awaited function returns, unchecked Object.assign writes, low-evidence tests, fast-check properties under a mocha timeout, files no tsconfig lists, tsconfigs that list no `types` and vitest configs off the shared test timeout. */
const guardrailsPlugin = eslintCompatPlugin({
  meta: { name: "antelopejs" },
  rules: withRuleDocs({
    "no-comments": noCommentsRule,
    "no-fs-read-in-tests": noFsReadInTestsRule,
    "no-inherited-key-lookup": noInheritedKeyLookupRule,
    "no-interface-instanceof": noInterfaceInstanceofRule,
    "no-presence-only-type-guard": noPresenceOnlyTypeGuardRule,
    "no-read-then-insert": noReadThenInsertRule,
    "no-constant-value-assertion": noConstantValueAssertionRule,
    "no-self-import-in-tests": noSelfImportInTestsRule,
    "no-typeof-function-only-test": noTypeofFunctionOnlyTestRule,
    "no-unrun-query": noUnrunQueryRule,
    "no-unsafe-object-assign": noUnsafeObjectAssignRule,
    "property-test-timeout": propertyTestTimeoutRule,
    "refusal-key-in-locales": refusalKeyInLocalesRule,
    "refusal-message-is-key": refusalMessageIsKeyRule,
    "require-assertion": requireAssertionRule,
    "require-tsconfig-include": requireTsconfigIncludeRule,
    "require-tsconfig-types": requireTsconfigTypesRule,
    "shared-test-timeout": sharedTestTimeoutRule,
  }),
});

export default guardrailsPlugin;
