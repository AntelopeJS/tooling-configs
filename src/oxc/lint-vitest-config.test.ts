import assert from "node:assert/strict";
import test from "node:test";

import { lintProject } from "./helpers/lint-project.ts";

const HAND_SET = "export default { test: { testTimeout: 20_000 } };\n";

test("the preset runs antelopejs/shared-test-timeout on vitest.config.* files and on no other file; a preset that never scopes the rule, or scopes it to every file, fails one of them", (t) => {
  const project = lintProject();
  t.after(project.remove);
  project.write("vitest.config.ts", HAND_SET);
  project.write("packages/app/vitest.config.mts", HAND_SET);
  project.write("src/settings.ts", HAND_SET);
  const reported = project
    .run()
    .diagnostics.filter(
      ({ code }: { code: string }) =>
        code === "antelopejs(shared-test-timeout)",
    )
    .map(({ filename }: { filename: string }) => filename);
  assert.deepEqual([...new Set(reported)].sort(), [
    "packages/app/vitest.config.mts",
    "vitest.config.ts",
  ]);
});
