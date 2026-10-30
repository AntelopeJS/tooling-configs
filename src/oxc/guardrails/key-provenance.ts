import type { ESTree, SourceCode, Variable } from "@oxlint/plugins";
import { resolveVariable, unwrapExpression } from "./local-types.ts";
import { callName } from "./shared.ts";

type Definition = Variable["defs"][number];

/** Where a list of keys comes from: string literals, or the own keys or entries of one table. */
type KeyList =
  | { kind: "literal" }
  | { kind: "keys" | "entries"; table: string };

const OWN_KEY_LISTS = new Set(["Object.keys", "Object.getOwnPropertyNames"]);
const KEY_PRESERVING_METHODS = new Set([
  "filter",
  "reverse",
  "slice",
  "sort",
  "toReversed",
  "toSorted",
]);
const ITERATING_METHODS = new Set([
  "every",
  "filter",
  "find",
  "findIndex",
  "flatMap",
  "forEach",
  "map",
  "some",
]);

/** A literal, a template without substitutions, or a `typeof` result: never an `Object.prototype` key. */
export function isStaticKey(key: ESTree.Node): boolean {
  if (key.type === "Literal") return true;
  if (key.type === "UnaryExpression") return key.operator === "typeof";
  return key.type === "TemplateLiteral" && key.expressions.length === 0;
}

function constInitializer(
  identifier: ESTree.Node & { name: string },
  source: SourceCode,
): ESTree.Expression | null {
  const [definition] = resolveVariable(source, identifier)?.defs ?? [];
  if (
    definition?.type !== "Variable" ||
    definition.parent?.type !== "VariableDeclaration" ||
    definition.parent.kind !== "const" ||
    definition.node.type !== "VariableDeclarator" ||
    definition.node.init === null
  )
    return null;
  let init = definition.node.init;
  while (
    init.type === "TSAsExpression" ||
    init.type === "TSSatisfiesExpression"
  )
    init = init.expression;
  return unwrapExpression(init);
}

function propertyValue(
  object: ESTree.ObjectExpression,
  name: string,
): ESTree.Node | null {
  for (const property of object.properties) {
    if (
      property.type === "Property" &&
      !property.computed &&
      property.key.type === "Identifier" &&
      property.key.name === name
    )
      return property.value;
  }
  return null;
}

/** `const KEY = "a"` or `const LABELS = { a: "x" }` read as `LABELS.a`, declared in this file. */
function isConstantKey(key: ESTree.Node, source: SourceCode): boolean {
  if (key.type === "Identifier") {
    const init = constInitializer(key, source);
    return init !== null && isStaticKey(init);
  }
  if (
    key.type !== "MemberExpression" ||
    key.computed ||
    key.object.type !== "Identifier" ||
    key.property.type !== "Identifier"
  )
    return false;
  const init = constInitializer(key.object, source);
  const value =
    init?.type === "ObjectExpression"
      ? propertyValue(init, key.property.name)
      : null;
  return value !== null && isStaticKey(value);
}

function keyList(
  node: ESTree.Node,
  source: SourceCode,
  depth = 0,
): KeyList | null {
  if (depth > 8) return null;
  if (node.type === "Identifier") {
    const init = constInitializer(node, source);
    return init === null ? null : keyList(init, source, depth + 1);
  }
  if (node.type === "ArrayExpression")
    return node.elements.every(
      (element) => element !== null && isStaticKey(element),
    )
      ? { kind: "literal" }
      : null;
  if (node.type !== "CallExpression") return null;
  const name = callName(node.callee);
  const [first] = node.arguments;
  if (first !== undefined && OWN_KEY_LISTS.has(name ?? ""))
    return { kind: "keys", table: source.getText(first) };
  if (first !== undefined && name === "Object.entries")
    return { kind: "entries", table: source.getText(first) };
  const callee = node.callee;
  return callee.type === "MemberExpression" &&
    !callee.computed &&
    callee.property.type === "Identifier" &&
    KEY_PRESERVING_METHODS.has(callee.property.name)
    ? keyList(callee.object, source, depth + 1)
    : null;
}

/** The pattern that binds a key: the whole binding, or the first element of `[key, value]`. */
function keyBinding(
  pattern: ESTree.Node,
  name: ESTree.Node,
): "plain" | "entry" | null {
  if (pattern === name) return "plain";
  return pattern.type === "ArrayPattern" && pattern.elements[0] === name
    ? "entry"
    : null;
}

/** The list a key is iterated from, with how it is bound, or a `for...in` loop. */
function keySource(
  definition: Definition,
): { list: ESTree.Node; binding: "plain" | "entry" | null } | null {
  if (definition.type === "Parameter") {
    const fn = definition.node;
    const call = fn.parent;
    if (
      (fn.type !== "ArrowFunctionExpression" &&
        fn.type !== "FunctionExpression") ||
      call?.type !== "CallExpression" ||
      call.arguments[0] !== fn ||
      call.callee.type !== "MemberExpression" ||
      call.callee.computed ||
      call.callee.property.type !== "Identifier" ||
      !ITERATING_METHODS.has(call.callee.property.name) ||
      fn.params[0] === undefined
    )
      return null;
    return {
      list: call.callee.object,
      binding: keyBinding(fn.params[0], definition.name),
    };
  }
  const loop = definition.parent?.parent;
  if (definition.node.type !== "VariableDeclarator") return null;
  if (loop?.type === "ForInStatement") return { list: loop, binding: "plain" };
  return loop?.type === "ForOfStatement"
    ? {
        list: loop.right,
        binding: keyBinding(definition.node.id, definition.name),
      }
    : null;
}

function isOwnKeyBinding(
  key: ESTree.Node,
  table: string,
  source: SourceCode,
): boolean {
  if (key.type !== "Identifier") return false;
  const [definition] = resolveVariable(source, key)?.defs ?? [];
  const found = definition === undefined ? null : keySource(definition);
  if (found === null || found.binding === null) return false;
  if (found.list.type === "ForInStatement")
    return source.getText(found.list.right) === table;
  const list = keyList(found.list, source);
  if (list === null) return false;
  if (list.kind === "literal") return found.binding === "plain";
  const binding = list.kind === "keys" ? "plain" : "entry";
  return list.table === table && found.binding === binding;
}

/**
 * Keys the rule can prove are not inherited: static keys, same-file constants, and keys iterated
 * from string literals or from `Object.keys`, `Object.entries` or `for...in` of the same table,
 * through `filter`, `sort` and similar key-preserving calls. Imported constants are not resolved.
 */
export function isKnownKey(
  key: ESTree.Node,
  table: string,
  source: SourceCode,
): boolean {
  return (
    isStaticKey(key) ||
    isConstantKey(key, source) ||
    isOwnKeyBinding(key, table, source)
  );
}

/** `Object.prototype.hasOwnProperty.call`, `{}.hasOwnProperty.call` and other `<x>.hasOwnProperty.call` forms. */
export function isHasOwnPropertyCall(callee: ESTree.Node): boolean {
  return (
    callee.type === "MemberExpression" &&
    !callee.computed &&
    callee.property.type === "Identifier" &&
    callee.property.name === "call" &&
    callee.object.type === "MemberExpression" &&
    !callee.object.computed &&
    callee.object.property.type === "Identifier" &&
    callee.object.property.name === "hasOwnProperty"
  );
}
