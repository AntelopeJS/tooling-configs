import { join } from "node:path";
import { RuleTester } from "oxlint/plugins-dev";

import { refusalMessageIsKeyRule } from "./refusal-message-is-key.ts";

const tester = new RuleTester({
  languageOptions: { parserOptions: { lang: "ts" } },
});
const fixtures = join(import.meta.dirname, "fixtures");
const filename = join(fixtures, "dms-module/src/index.ts");
const nonDms = join(fixtures, "plain-module/src/index.ts");
const withDependency = join(fixtures, "dms-dependent/src/index.ts");
const error = { messageId: "sentence" };

tester.run("antelopejs/refusal-message-is-key", refusalMessageIsKeyRule, {
  valid: [
    { code: 'assert(ok, 403, "$database.connection_refused");', filename },
    { code: 'assert(ok, 404, "database.not_found");', filename },
    {
      code: 'const KEY = "$database.connection.refused"; assert(ok, 409, KEY);',
      filename,
    },
    { code: "assert(ok, 422, `$database.invalid`);", filename },
    {
      name: "a key built from an interpolated template literal",
      code: "assert(ok, 404, `$database.${kind}_not_found`);",
      filename,
    },
    { code: 'assert(ok, 500, "Something broke");', filename },
    { code: 'assert(ok, 400, "Bad request");', filename },
    { code: 'assert(ok, status, "Not a known status");', filename },
    { code: "assert(ok, 403, message);", filename },
    { code: 'new HTTPResult(404, "$database.not_found");', filename },
    {
      code: 'new HTTPResult(404, { message: "$database.not_found", params });',
      filename,
    },
    { code: 'new HTTPResult(500, "Server exploded");', filename },
    { code: 'new HTTPResult(404, { code: "Not here" });', filename },
    { code: 'other(ok, 403, "Forbidden sentence");', filename },
    {
      name: "a non-DMS module's HTTPResult sentence is its own message",
      code: 'import { HTTPResult } from "@antelopejs/interface-api"; throw new HTTPResult(404, "User not found");',
      filename: nonDms,
    },
    {
      name: "a non-DMS module's assert sentence",
      code: 'assert(ok, 404, "User not found");',
      filename: nonDms,
    },
    {
      name: "a hyphenated module name is a key",
      code: 'assert(ok, 403, "$dms-database.denied");',
      filename,
    },
    {
      name: "a camelCase module name is a key",
      code: 'new HTTPResult(404, "$dmsDatabase.not_found");',
      filename,
    },
  ],
  invalid: [
    {
      name: "dms-database#172: refusal answered an English sentence",
      code: 'assert(connection, 404, "Database connection not found");',
      filename,
      errors: [error],
    },
    {
      name: "dms-database#189: HTTPResult with a sentence",
      code: 'throw new HTTPResult(409, "A connection with this name already exists");',
      filename,
      errors: [error],
    },
    {
      name: "dms-database#190: HTTPResult with a message object",
      code: 'throw new HTTPResult(422, { message: "The connection string is not valid" });',
      filename,
      errors: [error],
    },
    {
      name: "template with a substitution",
      code: "assert(ok, 403, `Cannot reach ${host}`);",
      filename,
      errors: [error],
    },
    {
      name: "template without a substitution",
      code: "assert(ok, 403, `Access denied`);",
      filename,
      errors: [error],
    },
    {
      name: "const holding a sentence",
      code: 'const DENIED = "Access denied"; assert(ok, 403, DENIED);',
      filename,
      errors: [error],
    },
    {
      name: "const status and a message with a space and a dot",
      code: 'const GONE = 410; new HTTPResult(GONE, "Gone. Really.");',
      filename,
      errors: [error],
    },
    {
      name: "a key with an uppercase letter is a sentence",
      code: 'assert(ok, 404, "Database.NotFound");',
      filename,
      errors: [error],
    },
    {
      name: "a single word is a sentence",
      code: 'assert(ok, 404, "Forbidden");',
      filename,
      errors: [error],
    },
    {
      name: "HTTPResult 4xx other than the assert statuses",
      code: 'new HTTPResult(401, "Unauthorized");',
      filename,
      errors: [error],
    },
    {
      name: "a module depending on interface-dms is a DMS module",
      code: 'throw new HTTPResult(404, "User not found");',
      filename: withDependency,
      errors: [error],
    },
  ],
});
