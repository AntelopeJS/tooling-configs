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
        code: "const T: Record<string, number> = { a: 1 }; function f(key: string) { const has = Object.hasOwn(T, key); if (!has) throw new Error(key); return T[key]; } function g(key: string) { if (Object.hasOwn(T, key) === false) return; return T[key]; } function h(key: string) { return Object.hasOwn(T, key) !== false ? T[key] : 0; } function i(key: string) { if (false == Object.hasOwn(T, key)) return; return T[key]; } function j(key: string) { return Object.hasOwn(T, key) != true ? 0 : T[key]; } function k(key: string, mode: number) { switch (mode) { case 1: if (!T.hasOwnProperty(key)) break; return T[key]; } }",
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
        name: "a check whose else branch exits or stores the key guards the statements after it",
        code: "const T: Record<string, number> = { a: 1 }; function f(key: string) { if (Object.hasOwn(T, key)) { log(); } else { return 0; } return T[key]; } function g(key: string) { if (Object.hasOwn(T, key)) log(); else T[key] = 0; return T[key]; }",
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
      {
        name: "a boolean comparison of a value that may not be boolean, an assert of something else, and a let flag",
        code: "const T: Record<string, number> = { a: 1 }; function f(k: string, y: string) { return (y && Object.hasOwn(T, k)) !== false ? T[k] : 0; } function g(k: string, y: string) { if ((y || !Object.hasOwn(T, k)) !== true) return T[k]; } function h(k: string, ok: boolean) { assert(ok); return T[k]; } function i(k: string) { let has = Object.hasOwn(T, k); has = true; if (!has) return; return T[k]; }",
        errors: [lookup, lookup, lookup, lookup],
      },
      {
        name: "a ??= store that reads first, a store into another table, and a const that names itself",
        code: "const T: Record<string, number> = { a: 1 }; const V: Record<string, number> = {}; function f(k: string) { if (!Object.hasOwn(T, k)) T[k] ??= 0; return T[k]; } function g(k: string) { if (!Object.hasOwn(T, k)) V[k] = 0; return T[k]; } function h(k: string) { const a = a; if (!a) return; return T[k]; }",
        errors: [lookup, lookup, lookup, lookup],
      },
    ],
  },
);
