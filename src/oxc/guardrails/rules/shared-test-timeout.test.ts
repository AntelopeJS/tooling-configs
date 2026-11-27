import { RuleTester } from "oxlint/plugins-dev";

import { sharedTestTimeoutRule } from "./shared-test-timeout.ts";

const tester = new RuleTester({
  languageOptions: { parserOptions: { lang: "ts" } },
});
const PRESET =
  'import { testTimeouts } from "@antelopejs/tooling-configs/vitest";';

tester.run("antelopejs/shared-test-timeout", sharedTestTimeoutRule, {
  valid: [
    {
      name: "a config that spreads the shared timeouts passes; a rule that reports every config reports it",
      code: `${PRESET}
import { defineConfig } from "vitest/config";
export default defineConfig({ test: { ...testTimeouts, projects: [{ extends: true, test: { name: "unit" } }] } });`,
    },
    {
      name: "a timeout read from another object passes; a rule that reports every mention of the name reports it",
      code: `${PRESET}
export default { test: { ...testTimeouts, name: options.testTimeout } };`,
    },
    {
      name: "a namespace import read for its testTimeouts passes; a rule that accepts only the named import reports it",
      code: `import * as shared from "@antelopejs/tooling-configs/vitest";
export default { test: { ...shared.testTimeouts } };`,
    },
  ],
  invalid: [
    {
      name: "dms-saas@f55e4ca:packages/dms-saas/vitest.config.ts:39 sets its own 20 s for the unit project; a rule that only checks the import passes it",
      code: `${PRESET}
import { defineConfig } from "vitest/config";
const UNIT_TEST_TIMEOUT_MS = 20_000;
export default defineConfig({ test: { ...testTimeouts, projects: [{ extends: true, test: { name: "unit", testTimeout: UNIT_TEST_TIMEOUT_MS } }, { extends: true, test: { name: "journeys", "hookTimeout": 1_200_000 } }] } });`,
      errors: [
        { messageId: "handSet", data: { key: "testTimeout" } },
        { messageId: "handSet", data: { key: "hookTimeout" } },
      ],
    },
    {
      name: "cloud@0e30711d:frontend-vue/vitest.config.ts runs on vitest's 5000 ms default; a rule that only reports hand-set keys passes it",
      code: `import { defineConfig } from "vitest/config";
export default defineConfig({ test: { environment: "happy-dom" } });`,
      errors: [{ messageId: "frameworkDefault" }],
    },
    ...[
      'import "@antelopejs/tooling-configs/vitest";',
      'import type { testTimeouts } from "@antelopejs/tooling-configs/vitest";',
      'import { type testTimeouts } from "@antelopejs/tooling-configs/vitest";',
      PRESET,
    ].map((line) => ({
      name: `\`${line}\` with testTimeouts never spread leaves the 5000 ms default; a rule that only checks the import passes it`,
      code: `${line}
export default { test: { retry: 1 } };`,
      errors: [{ messageId: "frameworkDefault" }],
    })),
    {
      name: "a template-literal key is a hand-set limit; a rule that reads only identifier and string keys passes it",
      code: `${PRESET}
export default { test: { ...testTimeouts, [\`testTimeout\`]: 1 } };`,
      errors: [{ messageId: "handSet", data: { key: "testTimeout" } }],
    },
  ],
});
