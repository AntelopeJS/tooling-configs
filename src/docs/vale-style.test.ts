import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { valeFiles } from "./vale-style.ts";
import { UNSLOP_RULES } from "./unslop-rules.ts";
import { UNSLOP_SKILL } from "./unslop-skill.ts";
import { readText, readTree } from "./helpers/files.ts";

const UPSTREAM = fileURLToPath(
  new URL("./fixtures/unslop-upstream.md", import.meta.url),
);
const COMMITTED = fileURLToPath(
  new URL("../../actions/docs/vale", import.meta.url),
);

test("the unslop skill, with its rule section rendered from the table, is the upstream text", () => {
  assert.equal(UNSLOP_SKILL, readText(UPSTREAM));
});

test("the table holds each rule id once, in ascending order", () => {
  const ids = UNSLOP_RULES.map(({ id }) => id);
  assert.deepEqual(
    ids,
    [...new Set(ids)].sort((a, b) => a - b),
  );
});

test("the Vale style in actions/docs/vale is what the table generates, file for file", () => {
  assert.deepEqual(
    Object.fromEntries(valeFiles()),
    Object.fromEntries(readTree(COMMITTED)),
  );
});

test("a rule changed in the table changes the generated style and the rendered skill", () => {
  const edited = UNSLOP_RULES.map((rule) =>
    rule.id === 13 && rule.check?.kind === "existence"
      ? { ...rule, check: { ...rule.check, tokens: ["x"] } }
      : rule,
  );
  assert.notDeepEqual(
    Object.fromEntries(valeFiles(edited)),
    Object.fromEntries(valeFiles()),
  );
});
