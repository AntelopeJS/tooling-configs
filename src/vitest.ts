import { TEST_TIMEOUT_MS } from "./test-timeout.ts";

/** The shared test timeout as vitest's per-test and per-hook limits. Spread it into a config's `test`, where projects with `extends: true` inherit it. */
export const testTimeouts = {
  testTimeout: TEST_TIMEOUT_MS,
  hookTimeout: TEST_TIMEOUT_MS,
} as const;
