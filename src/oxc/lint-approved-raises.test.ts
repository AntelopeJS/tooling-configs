import assert from "node:assert/strict";
import { test } from "node:test";

import { lintProject } from "./helpers/lint-project.ts";

const COMMENT = "antelopejs(no-comments)";
const OBJECT = "anti-slop(no-object-parameters)";

function codes(approved?: string): string[] {
  const project = lintProject();
  try {
    project.write(
      "debt.test.ts",
      "// Ordinary comment\nexport function untyped(value: object) { return value; }\n",
    );
    const result = project.run(
      false,
      project.root,
      approved === undefined ? {} : { APPROVED_RAISES: approved },
    );
    return result.diagnostics.map(
      (diagnostic: { code: string }) => diagnostic.code,
    );
  } finally {
    project.remove();
  }
}

test("a rule absent from the ceilings is reported", () => {
  const reported = codes();
  assert(reported.includes(COMMENT), reported.join());
  assert(reported.includes(OBJECT), reported.join());
});

test("APPROVED_RAISES switches no rule off, under its name or an alias", () => {
  for (const approved of [
    "antelopejs/no-comments=1",
    "no-comments=1",
    "eslint/no-debugger=1 no-debugger=1",
  ]) {
    const reported = codes(approved);
    assert(reported.includes(COMMENT), `${approved}: ${reported.join()}`);
    assert(reported.includes(OBJECT), `${approved}: ${reported.join()}`);
  }
});
