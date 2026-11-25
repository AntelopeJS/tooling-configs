import { join } from "node:path";
import { RuleTester } from "oxlint/plugins-dev";

import { noInterfaceInstanceofRule } from "./no-interface-instanceof.ts";

const tester = new RuleTester({
  languageOptions: { parserOptions: { lang: "ts" } },
});
const inInterface = join(
  import.meta.dirname,
  "fixtures/interface-package/src/index.ts",
);
const error = (name: string) => ({
  messageId: "instanceofInterface",
  data: { name },
});

tester.run("antelopejs/no-interface-instanceof", noInterfaceInstanceofRule, {
  valid: [
    'import { IsStream } from "@antelopejs/interface-data-api"; if (IsStream(value)) use(value);',
    'import { Stream } from "other-package"; value instanceof Stream;',
    'import type { Stream } from "@antelopejs/interface-data-api"; type T = Stream;',
    "class Local {} value instanceof Local;",
    "value instanceof Error;",
    'import { Stream } from "./stream.ts"; value instanceof Stream;',
    {
      name: "a class exported by an interface package is fine outside one",
      code: "export class Stream {} value instanceof Stream;",
      filename: "module.ts",
    },
    {
      name: "a local, unexported class in an interface package",
      code: "class Private {} value instanceof Private;",
      filename: inInterface,
    },
    {
      name: "a parameter that shadows an imported class",
      code: 'import { Stream } from "@antelopejs/interface-data-api"; function f(Stream: Function, v: unknown) { return v instanceof Stream; }',
    },
    {
      name: "a parameter that shadows a namespace import",
      code: 'import * as core from "@antelopejs/interface-core"; function f(core: { AsyncProxy: Function }, x: unknown) { return x instanceof core.AsyncProxy; }',
    },
    {
      name: "a local class that shadows an interface package's own exported class",
      code: "export class Stream {} export function check(v: unknown) { class Stream {} return v instanceof Stream; }",
      filename: inInterface,
    },
  ],
  invalid: [
    {
      name: "interface-data-api#35: query instanceof Stream",
      code: 'import { Stream } from "@antelopejs/interface-data-api"; if (query instanceof Stream) read(query);',
      errors: [error("Stream")],
    },
    {
      name: "interface-core#9: proxy instanceof AsyncProxy",
      code: 'import { AsyncProxy, EventProxy } from "@antelopejs/interface-core/proxy"; const a = target instanceof AsyncProxy; const b = target instanceof EventProxy;',
      errors: [error("AsyncProxy"), error("EventProxy")],
    },
    {
      name: "renamed import",
      code: 'import { RegisteringProxy as Reg } from "@antelopejs/interface-core"; x instanceof Reg;',
      errors: [error("Reg")],
    },
    {
      name: "namespace import",
      code: 'import * as core from "@antelopejs/interface-core"; x instanceof core.AsyncProxy;',
      errors: [error("AsyncProxy")],
    },
    {
      name: "interface-core#7: error class of an interface",
      code: 'import { InterfaceError } from "@antelopejs/interface-core"; if (!(e instanceof InterfaceError)) throw e;',
      errors: [error("InterfaceError")],
    },
    {
      name: "an interface package's own exported class",
      code: "export class Stream {} export function check(v: unknown) { return v instanceof Stream; }",
      filename: inInterface,
      errors: [error("Stream")],
    },
    {
      name: "an interface package's class exported through an export list",
      code: "class S {} class R {} export { S, R as Renamed }; export function check(v: unknown) { return v instanceof S || v instanceof R; }",
      filename: inInterface,
      errors: [error("S"), error("R")],
    },
  ],
});
