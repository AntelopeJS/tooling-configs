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

test("a rule absent from the ceilings is reported without APPROVED_RAISES", () => {
  const reported = codes();
  assert(reported.includes(COMMENT), reported.join());
  assert(reported.includes(OBJECT), reported.join());
});

test("APPROVED_RAISES turns off exactly the rules it lists", () => {
  const reported = codes("antelopejs/no-comments=1");
  assert(!reported.includes(COMMENT), reported.join());
  assert(reported.includes(OBJECT), reported.join());
});

test("a malformed APPROVED_RAISES approves nothing", () => {
  for (const malformed of [
    "antelopejs/no-comments",
    "antelopejs/no-comments=one",
    "antelopejs/no-comments=1 antelopejs/no-comments=2",
  ]) {
    const reported = codes(malformed);
    assert(reported.includes(COMMENT), `${malformed}: ${reported.join()}`);
    assert(reported.includes(OBJECT), `${malformed}: ${reported.join()}`);
  }
});
