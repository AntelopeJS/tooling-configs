import { eslintCompatPlugin } from "@oxlint/plugins";

import { noCommentsRule } from "./rules/no-comments.ts";
import { noConstantValueAssertionRule } from "./rules/no-constant-value-assertion.ts";
import { noFsReadInTestsRule } from "./rules/no-fs-read-in-tests.ts";
import { noInheritedKeyLookupRule } from "./rules/no-inherited-key-lookup.ts";
import { noPresenceOnlyTypeGuardRule } from "./rules/no-presence-only-type-guard.ts";
import { noReadThenInsertRule } from "./rules/no-read-then-insert.ts";
import { noSelfImportInTestsRule } from "./rules/no-self-import-in-tests.ts";
import { noTypeofFunctionOnlyTestRule } from "./rules/no-typeof-function-only-test.ts";
import { noUnrunQueryRule } from "./rules/no-unrun-query.ts";
import { noUnsafeAnyInVueRule } from "./rules/no-unsafe-any-in-vue.ts";
import { noUnsafeObjectAssignRule } from "./rules/no-unsafe-object-assign.ts";
import { requireAssertionRule } from "./rules/require-assertion.ts";
import { requireTsconfigIncludeRule } from "./rules/require-tsconfig-include.ts";
import { requireTsconfigTypesRule } from "./rules/require-tsconfig-types.ts";

export { ASSERTION_FUNCTION_NAMES, TEST_FILE_GLOBS } from "./shared.ts";

/** AntelopeJS rules that reject comments, inherited-key lookups, presence-only type guards, inserts that follow a read of the same table or that a called function makes once an awaited read found nothing, unrun interface-database queries an awaited function returns, unchecked Object.assign writes, `any` assigned, passed or returned in a Vue script, low-evidence tests, files no tsconfig lists and tsconfigs that list no `types`. */
const guardrailsPlugin = eslintCompatPlugin({
  meta: { name: "antelopejs" },
  rules: {
    "no-comments": noCommentsRule,
    "no-fs-read-in-tests": noFsReadInTestsRule,
    "no-inherited-key-lookup": noInheritedKeyLookupRule,
    "no-presence-only-type-guard": noPresenceOnlyTypeGuardRule,
    "no-read-then-insert": noReadThenInsertRule,
    "no-constant-value-assertion": noConstantValueAssertionRule,
    "no-self-import-in-tests": noSelfImportInTestsRule,
    "no-typeof-function-only-test": noTypeofFunctionOnlyTestRule,
    "no-unrun-query": noUnrunQueryRule,
    "no-unsafe-any-in-vue": noUnsafeAnyInVueRule,
    "no-unsafe-object-assign": noUnsafeObjectAssignRule,
    "require-assertion": requireAssertionRule,
    "require-tsconfig-include": requireTsconfigIncludeRule,
    "require-tsconfig-types": requireTsconfigTypesRule,
  },
});

export default guardrailsPlugin;
