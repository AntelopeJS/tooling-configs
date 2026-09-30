import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { checkInterfaceRanges, readFloor } from "./interface-ranges.ts";

const consumer = (spec: string) =>
  checkInterfaceRanges({
    dependencies: { "@antelopejs/interface-database": spec },
  });

const implementer = (spec: string) =>
  checkInterfaceRanges({
    dependencies: { "@antelopejs/interface-dms": spec },
    antelopeJs: { implements: ["@antelopejs/interface-dms"] },
  });

describe("checkInterfaceRanges", () => {
  it("accepts a consumer range open up to the next breaking release", () => {
    assert.deepEqual(consumer(">=0.1.7 <1.0.0"), []);
    assert.deepEqual(consumer(">=1.2.0 <2.0.0"), []);
  });

  it("refuses an exact pin and suggests the open range", () => {
    assert.deepEqual(consumer("0.1.7"), [
      {
        field: "dependencies",
        name: "@antelopejs/interface-database",
        spec: "0.1.7",
        role: "consumer",
        expected: ">=0.1.7 <1.0.0",
      },
    ]);
  });

  it("refuses a 0.x caret or tilde", () => {
    assert.equal(consumer("^0.1.2")[0]?.expected, ">=0.1.2 <1.0.0");
    assert.equal(consumer("~0.1.2")[0]?.expected, ">=0.1.2 <1.0.0");
  });

  it("refuses a consumer range capped below the next breaking release", () => {
    assert.equal(consumer(">=0.1.7 <0.2.0")[0]?.expected, ">=0.1.7 <1.0.0");
  });

  it("reports a spec it cannot read without suggesting one", () => {
    const [violation] = consumer("*");
    assert.equal(violation?.spec, "*");
    assert.equal(violation?.expected, undefined);
  });

  it("requires the implementer to cap below the next minor", () => {
    assert.deepEqual(implementer(">=0.3.1 <0.4.0"), []);
    assert.equal(implementer(">=0.3.1 <1.0.0")[0]?.expected, ">=0.3.1 <0.4.0");
    assert.equal(implementer(">=0.3.1 <0.5.0")[0]?.role, "implementer");
  });

  it("caps an implementer below the minor after the interface in the repository", () => {
    const check = (spec: string) =>
      checkInterfaceRanges(
        {
          dependencies: { "@antelopejs/interface-dms-mailing": spec },
          antelopeJs: { implements: ["@antelopejs/interface-dms-mailing"] },
        },
        new Map([["@antelopejs/interface-dms-mailing", "0.5.0"]]),
      );
    assert.equal(check(">=0.4.0 <1.0.0")[0]?.expected, ">=0.5.0 <0.6.0");
    assert.equal(check(">=0.4.0 <0.5.0")[0]?.expected, ">=0.5.0 <0.6.0");
    assert.deepEqual(check(">=0.5.0 <0.6.0"), []);
  });

  it("leaves workspace, file and link specs alone", () => {
    for (const spec of [
      "workspace:*",
      "file:../interface",
      "link:../interface",
    ]) {
      assert.deepEqual(consumer(spec), []);
    }
  });

  it("checks optional dependencies and ignores other packages", () => {
    const violations = checkInterfaceRanges({
      dependencies: {
        "@antelopejs/core": "1.10.1",
        "@antelopejs/interface-api": ">=0.0.14 <1.0.0",
      },
      optionalDependencies: { "@antelopejs/interface-redis": "^0.1.0" },
    });
    assert.deepEqual(
      violations.map(({ field, name }) => ({ field, name })),
      [{ field: "optionalDependencies", name: "@antelopejs/interface-redis" }],
    );
  });
});

describe("readFloor", () => {
  it("reads the lowest release of the shapes it knows", () => {
    assert.deepEqual(readFloor(">=0.1.7 <1.0.0"), [0, 1, 7]);
    assert.deepEqual(readFloor("^0.0.13"), [0, 0, 13]);
    assert.deepEqual(readFloor("0.2.0"), [0, 2, 0]);
    assert.equal(readFloor("latest"), undefined);
  });
});
