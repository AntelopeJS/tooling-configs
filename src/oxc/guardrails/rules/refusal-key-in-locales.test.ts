import { join } from "node:path";
import { RuleTester } from "oxlint/plugins-dev";

import { refusalKeyInLocalesRule } from "./refusal-key-in-locales.ts";

const tester = new RuleTester({
  languageOptions: { parserOptions: { lang: "ts" } },
});
const fixtures = join(import.meta.dirname, "fixtures");
const filename = join(fixtures, "dms-locales/src/routes/connections.ts");
const noLocales = join(fixtures, "dms-module/src/index.ts");
const missing = (key: string) => ({ messageId: "missing", data: { key } });

tester.run("antelopejs/refusal-key-in-locales", refusalKeyInLocalesRule, {
  valid: [
    {
      name: "a key the module's locale files hold",
      code: 'assert(ok, 404, "$dms_app.connections.unknown");',
      filename,
    },
    {
      name: "a key a layer's locale file holds",
      code: 'throw new HTTPResult(403, { message: "$dms_app.auth.denied" });',
      filename,
    },
    {
      name: "a key held through a const",
      code: 'const KEY = "$dms_app.connections.unknown"; assert(ok, 404, KEY);',
      filename,
    },
    {
      name: "a namespace another module's locales own",
      code: 'assert(ok, 404, "$dms_other.connections.unknown");',
      filename,
    },
    {
      name: "a module that ships no locale file",
      code: 'assert(ok, 404, "$dms_app.connections.gone");',
      filename: noLocales,
    },
    {
      name: "a key built from a substitution",
      code: "assert(ok, 404, `$dms_app.connections.${kind}`);",
      filename,
    },
    {
      name: "a key without the $ prefix is not resolved by the presenter",
      code: 'assert(ok, 404, "dms_app.connections.gone");',
      filename,
    },
    {
      name: "a status that is not a refusal",
      code: 'assert(ok, 500, "$dms_app.connections.gone");',
      filename,
    },
  ],
  invalid: [
    {
      name: "a key no locale file holds",
      code: 'assert(ok, 404, "$dms_app.connections.gone");',
      filename,
      errors: [missing("dms_app.connections.gone")],
    },
    {
      name: "a key naming a locale group instead of a sentence",
      code: 'throw new HTTPResult(409, "$dms_app.connections");',
      filename,
      errors: [missing("dms_app.connections")],
    },
    {
      name: "a missing key sent through an aliased assert",
      code: 'import { assert as throwHttpAssert } from "@antelopejs/interface-api-util"; throwHttpAssert(ok, 403, "$dms_app.auth.forbidden");',
      filename,
      errors: [missing("dms_app.auth.forbidden")],
    },
  ],
});
