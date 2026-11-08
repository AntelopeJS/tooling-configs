import { RuleTester } from "oxlint/plugins-dev";

import { noInheritedKeyLookupRule } from "./no-inherited-key-lookup.ts";

const tester = new RuleTester({
  languageOptions: { parserOptions: { lang: "ts" } },
});
const lookup = { messageId: "lookup" };

tester.run(
  "antelopejs/no-inherited-key-lookup own-key guards",
  noInheritedKeyLookupRule,
  {
    valid: [
      {
        name: "Object.hasOwn guards the right side of &&, and the else branch of a negated test",
        code: "const T: Record<string, number> = { a: 1 }; function f(key: string) { if (!Object.hasOwn(T, key)) use(0); else use(T[key]); return ready && Object.hasOwn(T, key) && T[key]; }",
      },
      {
        name: "an early continue on a failed Object.hasOwn guards the rest of the loop body",
        code: "const T: Record<string, number> = { a: 1 }; function f(keys: string[]) { for (const key of keys) { if (!Object.hasOwn(T, key)) { skip(key); continue; } use(T[key]); } }",
      },
      {
        name: "a check held in a const, compared with a boolean, or failing into a throw or a switch-case break",
        code: "const T: Record<string, number> = { a: 1 }; function f(key: string, mode: number) { const has = Object.hasOwn(T, key); if (!has) throw new Error(key); use(T[key]); if (Object.hasOwn(T, key) === false) return; use(Object.hasOwn(T, key) !== false ? T[key] : 0); switch (mode) { case 1: if (!T.hasOwnProperty(key)) break; use(T[key]); } }",
      },
      {
        name: "a while or for test guards its body and update",
        code: "const T: Record<string, string> = { a: 'b' }; function f(start: string) { let key = start; while (Object.hasOwn(T, key)) key = T[key]; for (let k = start; Object.hasOwn(T, k); k = T[k]) use(k); }",
      },
      {
        name: "a failed check whose branch exits through both arms of an inner if, or exits beside an else",
        code: "const T: Record<string, number> = { a: 1 }; function f(key: string, x: boolean) { if (!Object.hasOwn(T, key)) { if (x) return 1; else return 2; } use(T[key]); if (!Object.hasOwn(T, key)) { return 0; } else { log(); } return T[key]; }",
      },
      {
        name: "interface-api src/controller.ts:194, a failed check that stores the key before the read",
        code: "class M { fields: Record<string, object> = {}; field(name: string) { if (!Object.hasOwn(this.fields, name)) { this.fields[name] = {}; } return this.fields[name]; } }",
      },
      {
        name: "rethinkdb src/implementations/database/schema.ts:112, an assert of the check, and a guard in an outer function",
        code: "const T: Record<string, number> = {}; function f(id: string) { assert(Object.prototype.hasOwnProperty.call(T, id)); return T[id]; } function g(id: string) { if (!Object.hasOwn(T, id)) return; return () => T[id]; }",
      },
    ],
    invalid: [
      {
        name: "interface-core#58 form c (tooling-configs#121), a read the Object.hasOwn result does not guard",
        code: `
type UnparsedRecord = Record<string, unknown>;
function c(implementation: UnparsedRecord, key: string) {
  return Object.hasOwn(implementation, key) ? implementation[key] : implementation[key];
}`,
        errors: [lookup],
      },
      {
        name: "a read before the Object.hasOwn check, and one after a check whose failure does not exit",
        code: "const T: Record<string, number> = { a: 1 }; function f(key: string) { const before = T[key]; if (!Object.hasOwn(T, key)) log(key); return [before, T[key], Object.hasOwn(T, key) || T[key]]; }",
        errors: [lookup, lookup, lookup],
      },
      {
        name: "a read before an early exit, a check either side of ||, a check on another table, and an exit on success",
        code: "const T: Record<string, number> = { a: 1 }; const U: Record<string, number> = {}; function f(key: string) { const before = T[key]; if (!Object.hasOwn(T, key)) return; return before; } function g(key: string, x: boolean) { if (Object.hasOwn(T, key) || x) use(T[key]); use(Object.hasOwn(U, key) ? T[key] : 0); if (U.hasOwnProperty(key)) return; return U[key]; }",
        errors: [lookup, lookup, lookup, lookup],
      },
      {
        name: "an exit that needs a second condition, an inner if that may not exit, and a store of another key",
        code: "const T: Record<string, number> = {}; function f(k: string, x: boolean) { if (!Object.hasOwn(T, k) && x) return; return T[k]; } function g(k: string, x: boolean) { if (!Object.hasOwn(T, k)) { if (x) return; } return T[k]; } function h(k: string, j: string) { if (!Object.hasOwn(T, k)) T[j] = 0; return T[k]; }",
        errors: [lookup, lookup, lookup],
      },
    ],
  },
);
