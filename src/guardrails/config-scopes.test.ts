import assert from "node:assert/strict";
import test from "node:test";

import { coveredLimits, globContains } from "./config-scopes.ts";

test("a glob contains only globs it names every file of, conservatively", () => {
  const contained: [string, string][] = [
    ["src/test/**", "src/test/unit/**"],
    ["src/test/**", "./src/test/**/*"],
    ["**/*.vue", "src/**/Showcase*.vue"],
    ["*", "src/**"],
    ["**/*", "*"],
    ["**/components/OgImage/**", "**/components/OgImage/*.vue"],
  ];
  const widened: [string, string][] = [
    ["src/test/**", "src/**"],
    ["src/*", "src/**"],
    ["src/*", "src/a/b"],
    ["x*", "*.vue"],
    ["*.ts", "*"],
    ["src/test/**", "*"],
    ["src/?", "src/*"],
    ["src/{a,b}/**", "src/a/**"],
    ["src/test/**", "src/test/../**"],
    ["src/test/**", "src/test/**/../../**"],
    ["src/test/**", "src/test/./../**"],
  ];
  for (const [wide, narrow] of contained)
    assert.equal(globContains(wide, narrow), true, `${wide} ⊇ ${narrow}`);
  for (const [wide, narrow] of widened)
    assert.equal(globContains(wide, narrow), false, `${wide} ⊉ ${narrow}`);
});

test("a narrower key borrows only the room a containing key of the same rule gives up", () => {
  assert.deepEqual(
    coveredLimits(
      { "r for src/**": 2, "s for src/**": 1 },
      {
        "r for src/**": 1,
        "r for src/a/**": 1,
        "s for src/b/**": 1,
        "s for src/**": 1,
      },
    ),
    {
      "r for src/**": 2,
      "r for src/a/**": 1,
      "s for src/**": 1,
      "s for src/b/**": 0,
    },
  );
});
