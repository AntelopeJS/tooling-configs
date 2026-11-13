import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  checkDependencyRanges,
  describeViolation,
  localVersions,
  readFloor,
} from "./dependency-ranges.ts";

const expected = (
  spec: string,
  name = "@antelopejs/interface-database",
): string | null | undefined =>
  checkDependencyRanges({ dependencies: { [name]: spec } }).map(
    (violation) => violation.expected ?? null,
  )[0];

describe("checkDependencyRanges", () => {
  it("refuses a 0.x range open past the next minor, where a check that keeps the old consumer rule accepts the range that pulled interface-database 0.4.0 into dms 0.19.6", () => {
    assert.equal(expected(">=0.3.0 <1.0.0"), ">=0.3.0 <0.4.0");
    assert.equal(expected(">=0.3.0"), ">=0.3.0 <0.4.0");
  });

  it("accepts every 0.x shape that stops at the next minor, where a check that reads only the bounded form fails a caret or tilde npm resolves the same way", () => {
    for (const spec of [">=0.3.1 <0.4.0", "^0.3.1", "~0.3.1", ">=0.3.1 <0.4"])
      assert.equal(expected(spec), undefined, spec);
  });

  it("refuses a 1.x range wider than a tilde and suggests one, where a check that stops at 0.x lets a caret pull a breaking core minor", () => {
    assert.equal(expected("^1.21.0", "@antelopejs/core"), "~1.21.0");
    assert.equal(expected(">=1.21.0 <2", "@antelopejs/core"), "~1.21.0");
    assert.equal(expected("~1.21.0", "@antelopejs/core"), undefined);
    assert.equal(expected(">=1.21.0 <1.22.0", "@antelopejs/core"), undefined);
  });

  it("refuses an exact pin or a 0.0.x caret, where a check that only caps from above lets a pin break module startup at the next patch", () => {
    assert.equal(expected("0.1.7"), ">=0.1.7 <0.2.0");
    assert.equal(expected("1.10.1", "@antelopejs/core"), "~1.10.1");
    assert.equal(expected("^0.0.11"), ">=0.0.11 <0.1.0");
  });

  it("reports a spec with no floor without suggesting one, where a check that skips what it cannot read passes `*` and `latest`", () => {
    assert.equal(expected("*"), null);
    assert.equal(expected("latest"), null);
  });

  it("checks every dependency field and only AntelopeJS packages, where a check limited to dependencies misses the devDependency and peer ranges that resolve a breaking release too", () => {
    const violations = checkDependencyRanges({
      dependencies: { semver: "^7.0.0" },
      devDependencies: { "@antelopejs/tooling-configs": ">=0.5.0 <1.0.0" },
      peerDependencies: { "@antelopejs/core": ">=1.21.0 <2" },
      optionalDependencies: { "@antelopejs/interface-redis": "^1.0.0" },
    });
    assert.deepEqual(
      violations.map(({ field, name }) => `${field} ${name}`),
      [
        "devDependencies @antelopejs/tooling-configs",
        "peerDependencies @antelopejs/core",
        "optionalDependencies @antelopejs/interface-redis",
      ],
    );
  });

  it("caps a range on a package in the same repository below the minor after its version there, where a check that reads only the declared floor keeps a range the sibling's release has left", () => {
    const local = new Map([["@antelopejs/interface-dms-mailing", "0.5.0"]]);
    const check = (spec: string) =>
      checkDependencyRanges(
        { devDependencies: { "@antelopejs/interface-dms-mailing": spec } },
        local,
      );
    assert.equal(check(">=0.4.0 <0.5.0")[0]?.expected, ">=0.5.0 <0.6.0");
    assert.equal(check(">=0.4.0 <0.5.0")[0]?.local, "0.5.0");
    assert.deepEqual(check(">=0.5.0 <0.6.0"), []);
    assert.deepEqual(check("^0.5.0"), []);
  });

  it("leaves file and link specs alone, where a check that reads them fails a module built against a linked folder", () => {
    for (const spec of ["file:../interface", "link:../interface"])
      assert.equal(expected(spec), undefined, spec);
  });

  it("judges a workspace spec as pnpm publishes it, where a check that skips every workspace spec lets `workspace:^` on a 1.x sibling publish a caret", () => {
    const check = (spec: string, version: string, isPrivate = false) =>
      checkDependencyRanges(
        {
          private: isPrivate,
          dependencies: { "@antelopejs/interface-demo": spec },
        },
        new Map([["@antelopejs/interface-demo", version]]),
      ).map((violation) => violation.expected);
    assert.deepEqual(check("workspace:^", "1.2.3"), ["workspace:~"]);
    assert.deepEqual(check("workspace:>=0.3.0", "0.4.0"), ["workspace:~"]);
    assert.deepEqual(check("workspace:*", "0.4.0"), ["workspace:~"]);
    assert.deepEqual(check("workspace:~", "1.2.3"), []);
    assert.deepEqual(check("workspace:^", "0.6.1"), []);
    assert.deepEqual(check("workspace:^", "1.2.3", true), []);
    assert.deepEqual(
      checkDependencyRanges({
        dependencies: { "@antelopejs/interface-demo": "workspace:^" },
      }),
      [],
    );
  });
});

describe("localVersions", () => {
  it("leaves out a name tracked at two versions, where a map that keeps the last manifest lets a test fixture move every range back to its version", () => {
    const versions = localVersions([
      { name: "@antelopejs/interface-x", version: "0.5.0" },
      { name: "@antelopejs/interface-x", version: "0.1.0" },
      { name: "@antelopejs/interface-y", version: "1.2.0" },
      { name: "@antelopejs/interface-y", version: "1.2.0" },
    ]);
    assert.deepEqual([...versions], [["@antelopejs/interface-y", "1.2.0"]]);
  });
});

describe("describeViolation", () => {
  it("names the field, package, spec, sibling version and fix, where a terse message leaves the reader to work out which range moves where", () => {
    const [violation] = checkDependencyRanges(
      { peerDependencies: { "@antelopejs/interface-dms": "^0.11.0" } },
      new Map([["@antelopejs/interface-dms", "0.12.3"]]),
    );
    assert.ok(violation);
    assert.equal(
      describeViolation(violation),
      'peerDependencies["@antelopejs/interface-dms"] is "^0.11.0": AntelopeJS packages ship breaking changes in minor releases, so it must stop below the next minor and admit 0.12.3, the version in this repository; use ">=0.12.3 <0.13.0"',
    );
  });
});

describe("readFloor", () => {
  it("reads the lowest release from the start of a spec, where a reader that needs the whole shape gives no fix for an open range", () => {
    assert.deepEqual(readFloor(">=0.1.7 <1.0.0"), [0, 1, 7]);
    assert.deepEqual(readFloor(">=0.4.0"), [0, 4, 0]);
    assert.deepEqual(readFloor("^1.2.3 || ^2.0.0"), [1, 2, 3]);
    assert.equal(readFloor("latest"), undefined);
  });
});
