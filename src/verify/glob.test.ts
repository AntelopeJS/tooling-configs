import assert from "node:assert/strict";
import test from "node:test";

import { matchesPath } from "./glob.ts";

test("wildcards match dotfiles and dot folders, where path.matchesGlob alone skips them", () => {
  assert.equal(
    matchesPath("frontend-vue/.prettierrc", "frontend-vue/**"),
    true,
  );
  assert.equal(matchesPath("frontend-vue/.prettierrc", "frontend-vue/*"), true);
  assert.equal(matchesPath(".github/workflows/ci.yml", "**"), true);
  assert.equal(matchesPath("src/.env", "src/**"), true);
});

test("a dot written in the glob matches only a dot, where a matcher that drops every leading dot lets .agents match agents", () => {
  assert.equal(matchesPath(".agents/skills/x.md", ".agents/**"), true);
  assert.equal(matchesPath("agents/skills/x.md", ".agents/**"), false);
  assert.equal(matchesPath(".ts", "*.ts"), false);
  assert.equal(matchesPath("src/a.ts", "src/b.ts"), false);
});
