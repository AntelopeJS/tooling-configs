import assert from "node:assert/strict";
import { test } from "node:test";

import { lintProject } from "./helpers/lint-project.ts";

const THENABLE = `export const settled = {
  then(resolve: (value: number) => void): void {
    resolve(1);
  },
};
`;

test("unicorn/no-thenable is off in test files only, so a thenable in production code stays reported", () => {
  const project = lintProject();
  try {
    project.write("src/settled.ts", THENABLE);
    project.write("src/settled.test.ts", THENABLE);
    project.write("src/test/stand-in.ts", THENABLE);
    project.write("test/stand-in.ts", THENABLE);
    const { diagnostics } = project.run();
    assert.deepEqual(
      diagnostics
        .filter(
          (diagnostic: { code: string }) =>
            diagnostic.code === "unicorn(no-thenable)",
        )
        .map((diagnostic: { filename: string }) => diagnostic.filename),
      ["src/settled.ts"],
    );
  } finally {
    project.remove();
  }
});
