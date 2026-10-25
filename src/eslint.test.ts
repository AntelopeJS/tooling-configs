import assert from "node:assert/strict";
import { test } from "node:test";

import { antelopeNuxtConfig } from "./eslint.ts";

test("Nuxt resolves every warning severity to error while preserving options and off", async () => {
  const configs = await antelopeNuxtConfig({
    rules: {
      "no-console": "warn",
      "no-debugger": 1,
      eqeqeq: ["warn", "always", { null: "ignore" }],
      curly: [1, "multi-line"],
      "no-alert": "off",
      "no-empty": [0, { allowEmptyCatch: true }],
    },
  }).append(
    { name: "global-ignores", ignores: ["cache/**"] },
    {
      rules: {
        "no-console": "warn",
        "no-debugger": 1,
        eqeqeq: ["warn", "always", { null: "ignore" }],
        curly: [1, "multi-line"],
        "no-alert": "off",
        "no-empty": [0, { allowEmptyCatch: true }],
        "no-var": "warn",
      },
    },
  );
  const rules = Object.assign({}, ...configs.map((config) => config.rules));
  assert.equal(rules["no-console"], "error");
  assert.equal(rules["no-debugger"], "error");
  assert.deepEqual(rules.eqeqeq, ["error", "always", { null: "ignore" }]);
  assert.deepEqual(rules.curly, ["error", "multi-line"]);
  assert.equal(rules["no-var"], "error");
  assert.equal(rules["no-alert"], "off");
  assert.deepEqual(rules["no-empty"], [0, { allowEmptyCatch: true }]);
  const globalIgnores = configs.find(
    (config) => config.name === "global-ignores",
  );
  assert(globalIgnores);
  assert(
    !("rules" in globalIgnores),
    "An ignores-only config must keep global ignore semantics",
  );
  for (const config of configs) {
    for (const rule of Object.values(config.rules ?? {})) {
      const severity = Array.isArray(rule) ? rule[0] : rule;
      assert.notEqual(severity, "warn");
      assert.notEqual(severity, 1);
    }
  }
});
