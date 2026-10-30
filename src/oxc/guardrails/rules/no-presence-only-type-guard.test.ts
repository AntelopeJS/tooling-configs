import { RuleTester } from "oxlint/plugins-dev";

import { noPresenceOnlyTypeGuardRule } from "./no-presence-only-type-guard.ts";

const tester = new RuleTester({
  languageOptions: { parserOptions: { lang: "ts" } },
});
const inheritedKey = { messageId: "inheritedKey" };
const presenceOnly = { messageId: "presenceOnly" };
const uncheckedMember = { messageId: "uncheckedMember" };

tester.run(
  "antelopejs/no-presence-only-type-guard",
  noPresenceOnlyTypeGuardRule,
  {
    valid: [
      {
        name: "rethinkdb@9e11d8f:src/implementations/database/utils.ts, the own-key form",
        code: "export function HasKey<T extends object>(map: T, key: PropertyKey): key is keyof T { return Object.prototype.hasOwnProperty.call(map, key); }",
      },
      {
        name: "Object.hasOwn",
        code: "function isStage(name: string): name is Stage { return Object.hasOwn(STAGES, name); }",
      },
      {
        name: "interface-database-decorators@fc2cead:src/tests/helpers/other-instance.ts:16, presence and value",
        code: `
interface ModuleInternals {
  _resolveFilename(request: string, parent: Module): string;
  _nodeModulePaths(directory: string): string[];
}
function hasInternals(
  candidate: typeof Module,
): candidate is typeof Module & ModuleInternals {
  return (
    "_resolveFilename" in candidate &&
    typeof candidate._resolveFilename === "function" &&
    "_nodeModulePaths" in candidate &&
    typeof candidate._nodeModulePaths === "function"
  );
}`,
      },
      {
        name: "dms-frontend@6270ca2:src/discovery.ts:52, every declared member is read",
        code: `
function isDevRegistry(value: unknown): value is { pid: number; servers: object } {
  return (
    isObjectLike(value) &&
    "pid" in value &&
    typeof value.pid === "number" &&
    "servers" in value &&
    typeof value.servers === "object" &&
    value.servers !== null
  );
}`,
      },
      {
        name: "a discriminating in over a union parameter",
        code: "interface Cat { meow(): void } interface Dog { bark(): void } function isCat(pet: Cat | Dog): pet is Cat { return 'meow' in pet; }",
      },
      {
        name: "a member typed unknown needs only its presence",
        code: "function hasMessage(value: object): value is { message: unknown } { return 'message' in value; }",
      },
      {
        name: "a member read through an alias",
        code: "interface Point { x: number } function isPoint(value: unknown): value is Point { if (!isObjectLike(value)) return false; const record = value; return 'x' in record && typeof record.x === 'number'; }",
      },
      {
        name: "a member checked by a helper given the parameter and the key",
        code: "interface Point { x: number } function isPoint(value: unknown): value is Point { return hasNumber(value, 'x'); }",
      },
      {
        name: "an in check outside a type predicate",
        code: "function has(table: object, key: string): boolean { return key in table; }",
      },
      {
        name: "a this predicate",
        code: "class Node { isLeaf(): this is Leaf { return 'value' in this; } }",
      },
      {
        name: "a predicate type the file does not declare",
        code: "function isHandshake(value: unknown): value is Pick<DevHandshake, 'pid'> { return isObjectLike(value) && typeof value.pid === 'number'; }",
      },
      {
        name: "cloud@f784b41e:src/auth/device-workspaces.ts:52, a null filter with an inferred parameter",
        code: "interface Membership { tenantId: string } const kept = checks.filter((membership): membership is Membership => membership !== null);",
      },
      {
        name: "dms-automation@85c0a32:packages/dms-automation/src/types/graph.ts:83, a discriminant on a typed parameter",
        code: "interface GroupNode { kind: 'group'; ports: Port[]; subgraph: Graph } export function isGroupNode(n: GraphNode): n is GroupNode { return n.kind === 'group'; }",
      },
      {
        name: "cloud@f784b41e:src/secrets/transit.ts:226, members checked through computed keys",
        code: "interface Fields { iv: string; ciphertext: string } function isFields(value: unknown): value is Fields { if (!isObjectLike(value)) return false; const fields = value; return ['iv', 'ciphertext'].every((key) => typeof fields[key] === 'string'); }",
      },
      {
        name: "cloud@f784b41e:frontend-vue/app/utils/cell-text.ts:38, members read through an inline cast",
        code: "interface Money { amount: number; currency: string } export function isMoney(v: unknown): v is Money { return typeof v === 'object' && v !== null && typeof (v as Money).amount === 'number' && typeof (v as Money).currency === 'string'; }",
      },
      {
        name: "members read through an angle-bracket cast",
        code: "interface Money { amount: number; currency: string } export function isMoney(v: unknown): v is Money { return typeof v === 'object' && v !== null && typeof (<Money>v).amount === 'number' && typeof (<Money>v).currency === 'string'; }",
      },
      {
        name: "a nested callback's in check on another binding",
        code: "function allKnown(keys: string[]): keys is Known[] { return keys.every((key) => Object.hasOwn(KNOWN, key)); }",
      },
    ],
    invalid: [
      {
        name: "mongodb@41c1535:src/implementations/database/utils.ts:50",
        code: `
export function hasKey<Table extends object>(
  table: Table,
  key: PropertyKey,
): key is keyof Table {
  return key in table;
}`,
        errors: [inheritedKey],
      },
      {
        name: "rethinkdb@4580c02:src/implementations/database/utils.ts:17",
        code: "export function HasKey<T extends object>(map: T, key: PropertyKey): key is keyof T { return key in map; }",
        errors: [inheritedKey],
      },
      {
        name: "mollie@60405ad:src/mollie/fields.ts:10",
        code: "function isKeyOf<T extends object>(table: T, key: PropertyKey): key is keyof T { return key in table; }",
        errors: [inheritedKey],
      },
      {
        name: "dms-database@b8d13a6:src/i18n/messages.ts:68 (dms-database#65)",
        code: "function hasMessage(locale: ServerLocale, id: string): id is MessageKey { return id in MESSAGES[locale]; }",
        errors: [inheritedKey],
      },
      {
        name: "dms-frontend@6270ca2:src/manifest-secrets.ts:21 (dms-frontend#204 r3)",
        code: "function isSecretName(name: string): name is ManifestSecretName { return name in MANIFEST_SECRET_ENV; }",
        errors: [inheritedKey],
      },
      {
        name: "an arrow predicate",
        code: "const isStage = (name: string): name is Stage => name in STAGES;",
        errors: [inheritedKey],
      },
      {
        name: "interface-database@94b13c5:src/tests/helpers/other-instance.ts:16",
        code: `
interface ModuleInternals {
  _resolveFilename(request: string, parent: Module): string;
  _nodeModulePaths(directory: string): string[];
}
function hasInternals(
  candidate: typeof Module,
): candidate is typeof Module & ModuleInternals {
  return "_resolveFilename" in candidate && "_nodeModulePaths" in candidate;
}`,
        errors: [presenceOnly, presenceOnly],
      },
      {
        name: "interface-database@94b13c5:src/tests/helpers/other-instance.ts:22",
        code: `
interface LoadableModule {
  load(filename: string): void;
}
function isLoadable(candidate: Module): candidate is Module & LoadableModule {
  return "load" in candidate;
}`,
        errors: [presenceOnly],
      },
      {
        name: "dms-frontend@6270ca2:src/discovery.ts:207 (dms-frontend#204 r1), updatedAt never checked",
        code: `
export interface DevHandshake {
  pid: number;
  bootstrapSecret: string;
  updatedAt?: string;
}
function isDevHandshake(value: unknown): value is DevHandshake {
  return (
    isObjectLike(value) &&
    "pid" in value &&
    typeof value.pid === "number" &&
    "bootstrapSecret" in value &&
    typeof value.bootstrapSecret === "string" &&
    value.bootstrapSecret !== ""
  );
}`,
        errors: [uncheckedMember],
      },
      {
        name: "an assertion function",
        code: "interface Point { x: number; y: number } function assertPoint(value: unknown): asserts value is Point { if (!isObjectLike(value) || typeof value.x !== 'number') throw new TypeError('not a point'); }",
        errors: [uncheckedMember],
      },
      {
        name: "dms-ai@a55de00:sidecar/src/agent/typecheck.ts:73, an object check claims three members",
        code: "interface ExecFailure { stdout: string; stderr: string; code: number } function isExecFailure(err: unknown): err is ExecFailure { return typeof err === 'object' && err !== null; }",
        errors: [uncheckedMember, uncheckedMember, uncheckedMember],
      },
      {
        name: "presence written as Object.hasOwn, as the lookup rule's message suggests",
        code: "interface Money { amount: number; currency: string } export function isMoneyOwn(v: unknown): v is Money { return typeof v === 'object' && v !== null && Object.hasOwn(v, 'amount') && Object.hasOwn(v, 'currency'); }",
        errors: [presenceOnly, presenceOnly],
      },
      {
        name: "presence written as Reflect.has and hasOwnProperty.call",
        code: "interface Money { amount: number; currency: string } export function isMoneyHas(v: unknown): v is Money { return isObjectLike(v) && Reflect.has(v, 'amount') && Object.prototype.hasOwnProperty.call(v, 'currency'); }",
        errors: [presenceOnly, presenceOnly],
      },
      {
        name: "presence written as {}.hasOwnProperty.call",
        code: "interface Money { amount: number } export function isMoneyCall(v: unknown): v is Money { return isObjectLike(v) && {}.hasOwnProperty.call(v, 'amount'); }",
        errors: [presenceOnly],
      },
      {
        name: "an inline type literal with a presence-only member",
        code: "function isReply(value: object): value is { messages: string[] } { return 'messages' in value; }",
        errors: [presenceOnly],
      },
    ],
  },
);
