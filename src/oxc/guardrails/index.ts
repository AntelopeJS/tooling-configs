import { eslintCompatPlugin } from "@oxlint/plugins";

import { noCommentsRule } from "./rules/no-comments.ts";
import { noConstantValueAssertionRule } from "./rules/no-constant-value-assertion.ts";
import { noFsReadInTestsRule } from "./rules/no-fs-read-in-tests.ts";
import { noInheritedKeyLookupRule } from "./rules/no-inherited-key-lookup.ts";
import { noPresenceOnlyTypeGuardRule } from "./rules/no-presence-only-type-guard.ts";
import { noSelfImportInTestsRule } from "./rules/no-self-import-in-tests.ts";
import { noTypeofFunctionOnlyTestRule } from "./rules/no-typeof-function-only-test.ts";
import { requireAssertionRule } from "./rules/require-assertion.ts";

export { ASSERTION_FUNCTION_NAMES, TEST_FILE_GLOBS } from "./shared.ts";

/** AntelopeJS rules that reject comments, inherited-key lookups, presence-only type guards and low-evidence tests. */
const guardrailsPlugin = eslintCompatPlugin({
  meta: { name: "antelopejs" },
  rules: {
    "no-comments": noCommentsRule,
    "no-fs-read-in-tests": noFsReadInTestsRule,
    "no-inherited-key-lookup": noInheritedKeyLookupRule,
    "no-presence-only-type-guard": noPresenceOnlyTypeGuardRule,
    "no-constant-value-assertion": noConstantValueAssertionRule,
    "no-self-import-in-tests": noSelfImportInTestsRule,
    "no-typeof-function-only-test": noTypeofFunctionOnlyTestRule,
    "require-assertion": requireAssertionRule,
  },
});

export default guardrailsPlugin;
