import { RuleTester } from "oxlint/plugins-dev";

import plugin from "./index.ts";

const tester = new RuleTester({
  languageOptions: { parserOptions: { lang: "ts" } },
});

tester.run(
  "tooling-internal/no-params-indexing",
  plugin.rules["no-params-indexing"],
  {
    valid: [
      "const parameters = argumentParameters(fn); parameters[0];",
      "type.typeArguments?.params[1];",
      "node.typeParameters.params.map(read);",
      "for (const item of node.typeParameters.params) read(item);",
      "const { params } = fn;",
      "fn.params;",
      "fn.params.length;",
    ],
    invalid: [
      { code: "fn.params[0];", errors: [{ messageId: "shifted" }] },
      { code: "fn.params.find(isNamed);", errors: [{ messageId: "shifted" }] },
      { code: "fn.params.some(isNamed);", errors: [{ messageId: "shifted" }] },
      {
        code: "for (const parameter of fn.params) read(parameter);",
        errors: [{ messageId: "shifted" }],
      },
      { code: "read(...fn.params);", errors: [{ messageId: "shifted" }] },
      { code: "fn.value.params[i];", errors: [{ messageId: "shifted" }] },
    ],
  },
);
