# `antelopejs/shared-test-timeout`

A vitest config with its own timeout drifts from the 30,000 ms timeout every AntelopeJS repository runs its tests on, and one with no timeout leaves its tests on vitest's 5000 ms default.

## What it flags

In a `vitest.config.*` file:

- A `testTimeout` or `hookTimeout` property anywhere in the file.
- A file that never uses `testTimeouts` from `@antelopejs/tooling-configs/vitest`. An import that is never used, or an `import type`, does not count.

A `vitest.config.*` that only extends a shared base file through `mergeConfig` is reported even when the base spreads `testTimeouts`: the rule reads only the file vitest loads.

## Fix

Import `testTimeouts` from `@antelopejs/tooling-configs/vitest`, spread it into `test`, and delete every `testTimeout` and `hookTimeout` the file sets. A project declared with `extends: true` inherits it from the root config.

## Example

```ts flagged fragment [vitest.config.ts]
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["test/**/*.test.ts"], testTimeout: 20_000 },
});
```

```ts fixed fragment [vitest.config.ts]
import { testTimeouts } from "@antelopejs/tooling-configs/vitest";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["test/**/*.test.ts"], ...testTimeouts },
});
```
