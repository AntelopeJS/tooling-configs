import { RuleTester } from "oxlint/plugins-dev";

import { refusalMessageIsKeyRule } from "./refusal-message-is-key.ts";

const tester = new RuleTester({
  languageOptions: { parserOptions: { lang: "ts" } },
});
const error = { messageId: "sentence" };

tester.run("antelopejs/refusal-message-is-key", refusalMessageIsKeyRule, {
  valid: [
    'assert(ok, 403, "$database.connection_refused");',
    'assert(ok, 404, "database.not_found");',
    'const KEY = "$database.connection.refused"; assert(ok, 409, KEY);',
    "assert(ok, 422, `$database.invalid`);",
    'assert(ok, 500, "Something broke");',
    'assert(ok, 400, "Bad request");',
    'assert(ok, status, "Not a known status");',
    "assert(ok, 403, message);",
    'new HTTPResult(404, "$database.not_found");',
    'new HTTPResult(404, { message: "$database.not_found", params });',
    'new HTTPResult(500, "Server exploded");',
    'new HTTPResult(404, { code: "Not here" });',
    'other(ok, 403, "Forbidden sentence");',
  ],
  invalid: [
    {
      name: "dms-database#172: refusal answered an English sentence",
      code: 'assert(connection, 404, "Database connection not found");',
      errors: [error],
    },
    {
      name: "dms-database#189: HTTPResult with a sentence",
      code: 'throw new HTTPResult(409, "A connection with this name already exists");',
      errors: [error],
    },
    {
      name: "dms-database#190: HTTPResult with a message object",
      code: 'throw new HTTPResult(422, { message: "The connection string is not valid" });',
      errors: [error],
    },
    {
      name: "template with a substitution",
      code: "assert(ok, 403, `Cannot reach ${host}`);",
      errors: [error],
    },
    {
      name: "template without a substitution",
      code: "assert(ok, 403, `Access denied`);",
      errors: [error],
    },
    {
      name: "const holding a sentence",
      code: 'const DENIED = "Access denied"; assert(ok, 403, DENIED);',
      errors: [error],
    },
    {
      name: "const status and a message with a space and a dot",
      code: 'const GONE = 410; new HTTPResult(GONE, "Gone. Really.");',
      errors: [error],
    },
    {
      name: "a key with an uppercase letter is a sentence",
      code: 'assert(ok, 404, "Database.NotFound");',
      errors: [error],
    },
    {
      name: "a single word is a sentence",
      code: 'assert(ok, 404, "Forbidden");',
      errors: [error],
    },
    {
      name: "HTTPResult 4xx other than the assert statuses",
      code: 'new HTTPResult(401, "Unauthorized");',
      errors: [error],
    },
  ],
});
