import assert from "node:assert/strict";
import { test } from "node:test";

import { parityLines } from "./helpers/unsafe-any-parity.ts";

const defaults = `declare const parsedAny: any;
let x: string;
let u: unknown;
const { a = parsedAny } = {} as { a?: any };
const { n: { b2 } = { b2: parsedAny } } = {} as { n?: { b2: string } };
({ x = parsedAny } = {} as { x?: any });
({ u = parsedAny } = {} as { u?: any });
const [[d] = [parsedAny]] = [] as [[string]?];
const { s: { t } = {} as { t: any } } = {} as { s?: { t: string } };
({ m: { x } = { x: "" } } = {} as { m: { x: any } });
void [a, b2, d, t];
`;

test("an any default into an any slot is reported for the slot and for the default, a nested pattern is destructured from its own default, and one with a default is not destructured from its source, on the lines tsgolint reports (fails if an any slot whose default is any is reported once, a binding element's default is not destructured, or a nested pattern with a default reads its source's slots)", () => {
  const expected = [4, 4, 5, 5, 6, 6, 7, 8, 9];
  assert.deepEqual(parityLines("Defaults", defaults), {
    ts: expected,
    vue: expected,
  });
});
