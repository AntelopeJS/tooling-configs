import assert from "node:assert/strict";
import test from "node:test";

import { matchesPath } from "./glob.ts";

test("wildcards match dotfiles and dot folders at any depth, where path.matchesGlob alone skips them", () => {
  for (const [file, glob] of [
    ["frontend-vue/.prettierrc", "frontend-vue/**"],
    ["frontend-vue/.prettierrc", "frontend-vue/*"],
    [".github/workflows/ci.yml", "**"],
    ["src/.cache/x.ts", "src/**"],
  ])
    assert.equal(matchesPath(file, glob), true, `${file} ${glob}`);
});

test("braces, classes, escapes and extglobs keep matching the dots they name, where a matcher that rewrites only segment-leading dots in the glob misses them", () => {
  for (const [file, glob] of [
    [".env", "{.env,.npmrc}"],
    ["src/.b/x", "src/{a,.b}/**"],
    [".x", "[.]x"],
    [".env", "@(.env|x)"],
    ["a/.x", "a/\\.x"],
  ])
    assert.equal(matchesPath(file, glob), true, `${file} ${glob}`);
});

test("a literal dot matches only a dot and negations still exclude dotfiles, where a matcher that drops leading dots or hides them behind a placeholder lets them through", () => {
  assert.equal(matchesPath(".agents/skills/x.md", ".agents/**"), true);
  assert.equal(matchesPath("agents/skills/x.md", ".agents/**"), false);
  assert.equal(matchesPath(".env", "[!.]*"), false);
  assert.equal(matchesPath("a/.env", "a/!(.*)"), false);
  assert.equal(matchesPath("src/a.ts", "src/b.ts"), false);
});
