import { RuleTester } from "oxlint/plugins-dev";

import { typedCwd } from "../../helpers/typed-cwd.ts";
import { noInheritedKeyLookupRule } from "./no-inherited-key-lookup.ts";

const tester = new RuleTester({
  cwd: typedCwd({ "modes.ts": "export type Mode = 'a' | 'b';\n" }),
  languageOptions: { parserOptions: { lang: "ts" } },
});
const lookup = { messageId: "lookup" };

tester.run(
  "antelopejs/no-inherited-key-lookup parameter and variable keys",
  noInheritedKeyLookupRule,
  {
    valid: [
      {
        name: "a string key narrowed by a call in the enclosing condition, caught by an implementation that reports every string-declared key",
        code: "import { levels, isLevelName } from './levels'; function f(level: string) { const a = isLevelName(level) ? levels[level] : 0; if (isLevelName(level)) use(levels[level]); return a + (isLevelName(level) && levels[level]); }",
      },
      {
        name: "a string key read from a local null-prototype table, caught by an implementation that ignores how the table was built",
        code: "const T = Object.create(null); const U = { __proto__: null, a: 1 }; class C { t = Object.create(null); m(k: string) { return this.t[k]; } } function f(k: string) { return [T[k], U[k]]; }",
      },
      {
        name: "an imported table read with a key of an imported literal union, caught by an implementation that treats an unresolved key type as open",
        code: "import type { Channel } from './channels'; import { outputs } from './outputs'; function f(channel: Channel) { return outputs[channel]; }",
      },
      {
        name: "a module constant read with a key typed by a local closed union or a type parameter",
        code: "type Mode = 'a' | 'b'; const T = { a: 1, b: 2 } as const; function f(m: Mode) { return T[m]; } function g<K extends keyof typeof T>(k: K) { return T[k]; }",
      },
      {
        name: "a key typed by a same-file string enum",
        code: "enum Mode { A = 'a', B = 'b' } const T = { a: 1, b: 2 }; function e(m: Mode) { return T[m]; }",
      },
      {
        name: "a key typed by a type parameter of the enclosing class",
        code: "type Closed = 'a' | 'b'; const T = { a: 1, b: 2 }; class C<K extends Closed> { m(k: K) { return T[k]; } }",
      },
      {
        name: "a closed constraint wins over a same-name open alias, caught by an implementation that resolves the alias first",
        code: "type K = string; const T = { a: 1, b: 2 }; function f<K extends 'a' | 'b'>(k: K) { return T[k]; }",
      },
      {
        name: "a key typed by a type parameter of an outer function",
        code: "type Closed = 'a' | 'b'; const T = { a: 1, b: 2 }; function outer<K extends Closed>() { return (k: K) => T[k]; }",
      },
      {
        name: "a key typed by an imported closed union, caught by an implementation that resolves only the types its file declares",
        code: "import type { Mode } from './modes.ts'; const T = { a: 1, b: 2 }; function f(m: Mode) { return T[m]; }",
      },
      {
        name: "number, bigint, boolean, symbol and optional closed keys, caught by an implementation that calls every member but a literal open",
        code: "type Mode = 'a' | 'b'; const T = { a: 1, b: 2 }; function f(i: number, n: bigint, b: boolean, s: symbol, m?: Mode) { return [T[i], T[n], T[b], T[s], T[m]]; }",
      },
      {
        name: "a closed type parameter in a union, caught by an implementation that resolves the constraint of a bare type parameter only",
        code: "type Closed = 'a' | 'b'; const T = { a: 1, b: 2 }; function f<K extends Closed>(k: K | 'a') { return T[k]; }",
      },
    ],
    invalid: [
      {
        name: "antelopejs#568: a string-declared key into a table typed in another file, caught by an implementation that reads only tables typed in this file",
        code: "import type { Config } from './config'; import { envModules } from './modules'; function f(config: Config, environment: string, module: string) { return [config.environments?.[environment], envModules[module]]; }",
        errors: [lookup, lookup],
      },
      {
        name: "antelopejs#574: an optional manifest record read with a string | undefined parameter",
        code: "import type { Manifest } from './manifest'; function f(manifest: Manifest, packageName: string | undefined) { return manifest.dependencies?.[packageName]; }",
        errors: [lookup],
      },
      {
        name: "a call on the key that leaves the read in its alternate, or a call on another variable of the same name, caught by an implementation that accepts any call in an enclosing condition",
        code: "import { levels, isLevelName } from './levels'; function f(level: string) { const a = isLevelName(level) ? 0 : levels[level]; return isLevelName(level) ? ((level: string) => levels[level])('x') : a; }",
        errors: [lookup, lookup],
      },
      {
        name: "a computed destructure with a string key and a let built with a null prototype then reassigned, caught by an implementation that widens member reads only or trusts any null-prototype initializer",
        code: "import { table } from './table'; function f(key: string) { const { [key]: value } = table; let t = Object.create(null); t = table; return [value, t[key]]; }",
        errors: [lookup, lookup],
      },
      {
        name: "a variable declared string | null, caught by an implementation that checks parameters only",
        code: "import { table } from './table'; const name: string | null = read(); export const value = table[name];",
        errors: [lookup],
      },
      {
        name: "a dictionary declared elsewhere read with a string parameter, caught by an implementation that resolves only tables declared in this file",
        code: "import { TABLE } from './table'; function f(key: string) { return TABLE[key]; }",
        errors: [lookup],
      },
      {
        name: "an open constraint wins over a same-name closed alias, caught by an implementation that resolves the alias first",
        code: "type K = 'a' | 'b'; const T = { a: 1, b: 2 }; function f<K extends string>(k: K) { return T[k]; }",
        errors: [lookup],
      },
      {
        name: "a key typed by an unconstrained type parameter of the enclosing class",
        code: "const T = { a: 1, b: 2 }; class ClsU<K> { m(k: K) { return T[k]; } }",
        errors: [lookup],
      },
      {
        name: "a key typed by a type parameter constrained to string",
        code: "const T = { a: 1, b: 2 }; function f<K extends string>(k: K) { return T[k]; }",
        errors: [lookup],
      },
      {
        name: "keys typed by keyof any and a template literal, caught by an implementation that knows only string and PropertyKey as open",
        code: "const T = { a: 1, b: 2 }; function f(k: keyof any, t: `on${string}`) { return [T[k], T[t]]; }",
        errors: [lookup, lookup],
      },
      {
        name: "a string key narrowed by a type predicate built on in, caught by an implementation that trusts the type narrowed at the read",
        code: "const T = { a: 1, b: 2 }; const isKey = (k: string): k is keyof typeof T => k in T; function f(k: string) { if (isKey(k)) return T[k]; }",
        errors: [lookup],
      },
    ],
  },
);
