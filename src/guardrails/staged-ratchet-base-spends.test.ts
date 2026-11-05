import assert from "node:assert/strict";
import test from "node:test";

import {
  ANNOTATED,
  baseRepo,
  CAST,
  check,
  git,
  MOLLIE_5_PRELUDE,
  SAFETY,
  stage,
} from "./helpers/staged-ratchet-repo.ts";
import { commit, put } from "./helpers/test-repo.ts";

const BODY = Array.from(
  { length: 12 },
  (_, index) => `export const k${index} = ${index};\n`,
).join("");
const PAIR = (tail: string) =>
  `${MOLLIE_5_PRELUDE}export const p = [readOwn({}) as Own, readOwn(\n  {},\n)${tail}];\n`;

interface Spend {
  name: string;
  base: Record<string, string>;
  earlier: (root: string) => void;
  later: (root: string) => void;
}

const SPENDS: Spend[] = [
  {
    name: "a SAFETY comment paid for a finding elsewhere, then is removed",
    base: {
      "x.ts": `${MOLLIE_5_PRELUDE}${CAST("a")}`,
      "y.ts": MOLLIE_5_PRELUDE,
    },
    earlier: (root) => {
      put(root, "x.ts", `${MOLLIE_5_PRELUDE}${ANNOTATED("a")}`);
      put(root, "y.ts", `${MOLLIE_5_PRELUDE}${CAST("b")}`);
    },
    later: (root) => put(root, "x.ts", `${MOLLIE_5_PRELUDE}${CAST("a")}`),
  },
  {
    name: "a legacy finding moved to another file is restored in its source",
    base: {
      "x.ts": `${MOLLIE_5_PRELUDE}${CAST("a")}export const z = 1;\n`,
      "y.ts": MOLLIE_5_PRELUDE,
    },
    earlier: (root) => {
      put(root, "x.ts", `${MOLLIE_5_PRELUDE}export const z = 1;\n`);
      put(root, "y.ts", `${MOLLIE_5_PRELUDE}${CAST("a")}`);
    },
    later: (root) =>
      put(root, "x.ts", `${MOLLIE_5_PRELUDE}${CAST("a")}export const z = 1;\n`),
  },
  {
    name: "one of two findings on a base line moved out, then another node there takes its place",
    base: { "x.ts": PAIR(" as Own"), "y.ts": MOLLIE_5_PRELUDE },
    earlier: (root) => {
      put(root, "x.ts", PAIR(""));
      put(root, "y.ts", `${MOLLIE_5_PRELUDE}${CAST("q")}`);
    },
    later: (root) => put(root, "x.ts", PAIR("").replace("];", "] as Own[];")),
  },
  {
    name: "a legacy finding moved out of a renamed file is restored in it",
    base: {
      "x.ts": `${MOLLIE_5_PRELUDE}${CAST("a")}${BODY}`,
      "y.ts": MOLLIE_5_PRELUDE,
    },
    earlier: (root) => {
      git(root, "mv", "x.ts", "z.ts");
      put(root, "z.ts", `${MOLLIE_5_PRELUDE}${BODY}export const extra = 1;\n`);
      put(root, "y.ts", `${MOLLIE_5_PRELUDE}${CAST("a")}`);
    },
    later: (root) =>
      put(
        root,
        "z.ts",
        `${MOLLIE_5_PRELUDE}${CAST("a")}${BODY}export const extra = 1;\n`,
      ),
  },
  {
    name: "a deleted file whose legacy finding moved out is re-created",
    base: {
      "x.ts": `${MOLLIE_5_PRELUDE}${CAST("a")}`,
      "y.ts": MOLLIE_5_PRELUDE,
    },
    earlier: (root) => {
      put(root, "y.ts", `${MOLLIE_5_PRELUDE}${CAST("a")}`);
      git(root, "rm", "-q", "x.ts");
    },
    later: (root) => put(root, "x.ts", `${MOLLIE_5_PRELUDE}${CAST("a")}`),
  },
];

for (const { name, base, earlier, later } of SPENDS)
  test(`staged ratchet fails a second claim on one base finding when ${name}`, (t) => {
    const root = baseRepo(t, base);
    earlier(root);
    stage(root, ".");
    const first = check(root);
    assert.equal(first.status, 0, first.stderr);
    commit(root);
    later(root);
    stage(root, ".");
    const second = check(root);
    assert.equal(second.status, 1);
    assert.match(second.stderr, new RegExp(`${SAFETY}: this commit adds 1`));
  });
