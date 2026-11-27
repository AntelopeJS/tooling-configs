import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { RuleTester } from "oxlint/plugins-dev";

import { refusalKeyInLocalesRule } from "./refusal-key-in-locales.ts";
import { refusalMessageIsKeyRule } from "./refusal-message-is-key.ts";

const REFUSALS = `export const REFUSALS = {
  unknown: "$dms_app.connections.unknown",
  gone: "$dms_app.connections.gone",
  sentence: "Connection not found",
} as const;

export const LOOSE = { gone: "$dms_app.connections.gone" };

export type RefusalKey =
  | "$dms_app.connections.unknown"
  | "$dms_app.auth.denied";

export type MixedKey = RefusalKey | "$dms_app.auth.forbidden";
`;

const FILES = {
  "package.json": JSON.stringify({ name: "dms-typed-fixture" }),
  "tsconfig.json": JSON.stringify({
    compilerOptions: {
      strict: true,
      types: [],
      module: "preserve",
      moduleResolution: "bundler",
      noEmit: true,
    },
    include: ["src/**/*.ts"],
  }),
  "frontend-vue/i18n/locales/app-en-GB.json": JSON.stringify({
    dms_app: {
      connections: { unknown: "Unknown connection" },
      auth: { denied: "Access denied" },
    },
  }),
  "src/refusals.ts": REFUSALS,
  "src/routes/connections.ts": "export {};\n",
};

const root = mkdtempSync(join(tmpdir(), "antelope-refusal-types-"));
for (const [path, text] of Object.entries(FILES)) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}
const filename = join(root, "src/routes/connections.ts");
const imported = 'import { REFUSALS, LOOSE } from "../refusals";\n';
const keys = 'import type { RefusalKey, MixedKey } from "../refusals";\n';
const missing = (key: string) => ({ messageId: "missing", data: { key } });

const tester = new RuleTester({
  languageOptions: { parserOptions: { lang: "ts" } },
});

tester.run("antelopejs/refusal-key-in-locales", refusalKeyInLocalesRule, {
  valid: [
    {
      name: "a held key read from a const object in another file",
      code: `${imported}assert(ok, 404, REFUSALS.unknown);`,
      filename,
    },
    {
      name: "a held key read from a const object in a message object",
      code: `${imported}throw new HTTPResult(404, { message: REFUSALS.unknown });`,
      filename,
    },
    {
      name: "a held key read from a local const object",
      code: 'const LOCAL = { unknown: "$dms_app.connections.unknown" } as const; assert(ok, 404, LOCAL.unknown);',
      filename,
    },
    {
      name: "a union of held keys",
      code: `${keys}export function refuse(key: RefusalKey) { assert(ok, 404, key); }`,
      filename,
    },
    {
      name: "an object without as const types its members as string, which names no key",
      code: `${imported}assert(ok, 404, LOOSE.gone);`,
      filename,
    },
  ],
  invalid: [
    {
      name: "dms-database: a missing key read from a const object in another file",
      code: `${imported}assert(ok, 404, REFUSALS.gone);`,
      filename,
      errors: [missing("dms_app.connections.gone")],
    },
    {
      name: "a missing key read by element access",
      code: `${imported}throw new HTTPResult(409, REFUSALS["gone"]);`,
      filename,
      errors: [missing("dms_app.connections.gone")],
    },
    {
      name: "a missing key read from a local const object",
      code: 'const LOCAL = { gone: "$dms_app.connections.gone" } as const; assert(ok, 404, LOCAL.gone);',
      filename,
      errors: [missing("dms_app.connections.gone")],
    },
    {
      name: "a const holding a missing key read from a const object",
      code: `${imported}const KEY = REFUSALS.gone; assert(ok, 404, KEY);`,
      filename,
      errors: [missing("dms_app.connections.gone")],
    },
    {
      name: "the one missing member of a union of keys",
      code: `${keys}export function refuse(key: MixedKey) { assert(ok, 403, key); }`,
      filename,
      errors: [missing("dms_app.auth.forbidden")],
    },
  ],
});

tester.run("antelopejs/refusal-message-is-key", refusalMessageIsKeyRule, {
  valid: [
    {
      name: "a key read from a const object in another file",
      code: `${imported}assert(ok, 404, REFUSALS.unknown);`,
      filename,
    },
    {
      name: "a message typed string",
      code: "export function refuse(message: string) { assert(ok, 404, message); }",
      filename,
    },
  ],
  invalid: [
    {
      name: "a sentence read from a const object in another file",
      code: `${imported}assert(ok, 404, REFUSALS.sentence);`,
      filename,
      errors: [{ messageId: "sentence" }],
    },
    {
      name: "a union holding a sentence",
      code: 'export function refuse(message: "$dms_app.auth.denied" | "Access denied") { throw new HTTPResult(403, message); }',
      filename,
      errors: [{ messageId: "sentence" }],
    },
  ],
});
