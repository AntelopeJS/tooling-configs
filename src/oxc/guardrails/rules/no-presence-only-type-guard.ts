import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";
import {
  collectLocalTypes,
  parameterPredicate,
  predicateName,
  referenceName,
  unwrapExpression,
  type LocalTypes,
} from "../local-types.ts";
import { memberName } from "../shared.ts";

type FunctionNode = ESTree.ArrowFunctionExpression | ESTree.Function;

/** Declared members by name; `null` for a method, whose value must be checked too. */
type Members = Map<string, ESTree.TSType | null>;

interface Presence {
  node: ESTree.BinaryExpression;
  object: string;
  key: string;
}

interface Frame {
  name: string;
  predicate: ESTree.TSTypePredicate;
  narrowed: ESTree.TSType;
  parameter: ESTree.TSType | undefined;
  aliases: Set<string>;
  reads: Array<readonly [string, string]>;
  dynamicReads: string[];
  presence: Presence[];
}

interface Environment {
  types: LocalTypes;
  guards: Map<string, ESTree.TSType>;
}

const MAX_ALIAS_DEPTH = 8;
const OPEN_TYPES = new Set(["TSUnknownKeyword", "TSAnyKeyword"]);
const WIDE_TYPES = new Set([...OPEN_TYPES, "TSObjectKeyword"]);

function signatureName(member: ESTree.TSSignature): string | null {
  if (
    (member.type !== "TSPropertySignature" &&
      member.type !== "TSMethodSignature") ||
    member.computed
  )
    return null;
  if (member.key.type === "Identifier") return member.key.name;
  return member.key.type === "Literal" ? String(member.key.value) : null;
}

function addSignatures(members: Members, body: ESTree.TSSignature[]): void {
  for (const member of body) {
    const name = signatureName(member);
    if (name === null) continue;
    members.set(
      name,
      member.type === "TSPropertySignature"
        ? (member.typeAnnotation?.typeAnnotation ?? null)
        : null,
    );
  }
}

function referenceMembers(
  type: ESTree.TSTypeReference,
  types: LocalTypes,
  depth: number,
): Members | null {
  const name = referenceName(type);
  if (name === null) return null;
  const alias = types.aliases.get(name);
  if (alias !== undefined) return declaredMembers(alias, types, depth + 1);
  const declarations = types.interfaces.get(name);
  if (declarations === undefined) return null;
  const members: Members = new Map();
  for (const declaration of declarations)
    addSignatures(members, declaration.body.body);
  return members;
}

/** The members a narrowed type declares in this file, or null when the file does not declare them. */
function declaredMembers(
  type: ESTree.TSType,
  types: LocalTypes,
  depth = 0,
): Members | null {
  if (depth > MAX_ALIAS_DEPTH) return null;
  switch (type.type) {
    case "TSParenthesizedType":
      return declaredMembers(type.typeAnnotation, types, depth);
    case "TSTypeLiteral": {
      const members: Members = new Map();
      addSignatures(members, type.members);
      return members;
    }
    case "TSTypeReference":
      return referenceMembers(type, types, depth);
    case "TSIntersectionType": {
      const parts = type.types
        .map((part) => declaredMembers(part, types, depth))
        .filter((part) => part !== null);
      return parts.length === 0
        ? null
        : new Map(parts.flatMap((part) => [...part]));
    }
    default:
      return null;
  }
}

function parameterType(
  fn: FunctionNode,
  name: string,
): ESTree.TSType | undefined {
  for (const parameter of fn.params) {
    const binding =
      parameter.type === "AssignmentPattern" ? parameter.left : parameter;
    if (binding.type === "Identifier" && binding.name === name)
      return binding.typeAnnotation?.typeAnnotation ?? undefined;
  }
  return undefined;
}

function isOpenRecord(type: ESTree.TSTypeReference): boolean {
  const value = type.typeArguments?.params[1];
  return (
    referenceName(type) === "Record" &&
    value !== undefined &&
    OPEN_TYPES.has(value.type)
  );
}

/**
 * A parameter typed `unknown`, `object`, `{}` or an open record carries no member types, so the guard
 * alone vouches for them. A named or inferred parameter type already declares what a discriminant leaves out.
 */
function isWide(type: ESTree.TSType | undefined): boolean {
  if (type === undefined) return false;
  if (WIDE_TYPES.has(type.type)) return true;
  if (type.type === "TSTypeLiteral") return type.members.length === 0;
  if (type.type === "TSTypeReference") return isOpenRecord(type);
  return type.type === "TSUnionType" && type.types.some(isWide);
}

function frameFor(fn: FunctionNode): Frame | null {
  const predicate = parameterPredicate(fn);
  const name = predicate === null ? null : predicateName(predicate);
  const narrowed = predicate?.typeAnnotation?.typeAnnotation;
  if (predicate === null || name === null || narrowed === undefined)
    return null;
  return {
    name,
    predicate,
    narrowed,
    parameter: parameterType(fn, name),
    aliases: new Set([name]),
    reads: [],
    dynamicReads: [],
    presence: [],
  };
}

function guardDeclarations(
  program: ESTree.Program,
): Map<string, ESTree.TSType> {
  const guards = new Map<string, ESTree.TSType>();
  const record = (name: string, fn: FunctionNode) => {
    const narrowed = parameterPredicate(fn)?.typeAnnotation?.typeAnnotation;
    if (narrowed !== undefined) guards.set(name, narrowed);
  };
  for (const statement of program.body) {
    const declaration =
      statement.type === "ExportNamedDeclaration"
        ? statement.declaration
        : statement;
    if (declaration?.type === "FunctionDeclaration" && declaration.id !== null)
      record(declaration.id.name, declaration);
    if (declaration?.type !== "VariableDeclaration") continue;
    for (const declarator of declaration.declarations) {
      const init = declarator.init;
      if (
        declarator.id.type === "Identifier" &&
        (init?.type === "ArrowFunctionExpression" ||
          init?.type === "FunctionExpression")
      )
        record(declarator.id.name, init);
    }
  }
  return guards;
}

function unwrapAlias(node: ESTree.Expression): ESTree.Expression {
  let current = unwrapExpression(node);
  while (
    current.type === "TSAsExpression" ||
    current.type === "TSSatisfiesExpression"
  )
    current = unwrapExpression(current.expression);
  return current;
}

function callReads(
  node: ESTree.CallExpression,
  environment: Environment,
): Array<readonly [string, string]> {
  const objects = node.arguments.flatMap((argument) =>
    argument.type === "Identifier" ? [argument.name] : [],
  );
  const keys = node.arguments.flatMap((argument) =>
    argument.type === "Literal" ? [String(argument.value)] : [],
  );
  const guard =
    node.callee.type === "Identifier"
      ? environment.guards.get(node.callee.name)
      : undefined;
  if (guard !== undefined)
    keys.push(...(declaredMembers(guard, environment.types)?.keys() ?? []));
  return objects.flatMap((object) => keys.map((key) => [object, key] as const));
}

/** A type predicate must check what it narrows to, not only that a key is present. */
export const noPresenceOnlyTypeGuardRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow type predicates that narrow on `in` alone: a key answered by the prototype, or a member whose value is never checked.",
    },
    messages: {
      inheritedKey:
        "`{{ key }} in ...` is also true for keys inherited from `Object.prototype` such as `constructor` and `toString`, so this guard narrows `{{ key }}` to keys the table does not have. Use `Object.hasOwn(table, {{ key }})`, or keep the keys in a `Map` or `Set` and call `.has({{ key }})`.",
      presenceOnly:
        '`"{{ key }}" in {{ param }}` checks only that `{{ key }}` is present, yet the guard narrows `{{ param }}` to a type that declares its value. Check the value too (`typeof {{ param }}.{{ key }} === "function"`, `Array.isArray({{ param }}.{{ key }})`, a nested guard), or parse `{{ param }}` with a schema.',
      uncheckedMember:
        "This guard narrows `{{ param }}` to `{{ type }}` but never reads `{{ param }}.{{ member }}`, so a value with any `{{ member }}` passes. Check it (`typeof`, `Array.isArray`, a nested guard), narrow to a type without it (`Pick<...>`), or parse `{{ param }}` with a schema.",
    },
  },
  createOnce(context) {
    let environment: Environment | null = null;
    const stack: Array<Frame | null> = [];
    const active = () => stack.filter((frame) => frame !== null);
    const enter = (fn: FunctionNode) => {
      stack.push(frameFor(fn));
    };
    const leave = () => {
      const frame = stack.pop();
      if (frame !== null && frame !== undefined && environment !== null)
        evaluate(frame, environment);
    };
    function evaluate(frame: Frame, env: Environment): void {
      const wide = isWide(frame.parameter);
      if (!wide && frame.narrowed.type !== "TSIntersectionType") return;
      const members = declaredMembers(frame.narrowed, env.types);
      const isRead = (key: string) =>
        frame.reads.some(
          ([object, read]) => read === key && frame.aliases.has(object),
        );
      const isOpen = (key: string) => {
        const type = members?.get(key);
        return type !== undefined && type !== null && OPEN_TYPES.has(type.type);
      };
      const present = new Set<string>();
      for (const presence of frame.presence) {
        if (!frame.aliases.has(presence.object)) continue;
        present.add(presence.key);
        if (isRead(presence.key) || isOpen(presence.key)) continue;
        context.report({
          node: presence.node,
          messageId: "presenceOnly",
          data: { key: presence.key, param: presence.object },
        });
      }
      const dynamic = frame.dynamicReads.some((object) =>
        frame.aliases.has(object),
      );
      if (!wide || dynamic) return;
      for (const member of members?.keys() ?? []) {
        if (isOpen(member) || present.has(member) || isRead(member)) continue;
        context.report({
          node: frame.predicate,
          messageId: "uncheckedMember",
          data: {
            member,
            param: frame.name,
            type: context.sourceCode.getText(frame.narrowed),
          },
        });
      }
    }
    return {
      Program(node) {
        environment = {
          types: collectLocalTypes(node),
          guards: guardDeclarations(node),
        };
        stack.length = 0;
      },
      FunctionDeclaration: enter,
      FunctionExpression: enter,
      ArrowFunctionExpression: enter,
      "FunctionDeclaration:exit": leave,
      "FunctionExpression:exit": leave,
      "ArrowFunctionExpression:exit": leave,
      MemberExpression(node) {
        if (node.object.type !== "Identifier") return;
        const object = node.object.name;
        const key = memberName(node);
        for (const frame of active()) {
          if (key === null) frame.dynamicReads.push(object);
          else frame.reads.push([object, key]);
        }
      },
      CallExpression(node) {
        if (environment === null) return;
        const reads = callReads(node, environment);
        for (const frame of active()) frame.reads.push(...reads);
      },
      VariableDeclarator(node) {
        if (node.init === null) return;
        const init = unwrapAlias(node.init);
        if (init.type !== "Identifier") return;
        for (const frame of active()) {
          if (!frame.aliases.has(init.name)) continue;
          if (node.id.type === "Identifier") frame.aliases.add(node.id.name);
          if (node.id.type !== "ObjectPattern") continue;
          for (const property of node.id.properties) {
            if (
              property.type === "Property" &&
              property.key.type === "Identifier"
            )
              frame.reads.push([init.name, property.key.name]);
          }
        }
      },
      BinaryExpression(node) {
        const frame = active().at(-1);
        if (node.operator !== "in" || frame === undefined) return;
        if (node.left.type === "Identifier" && node.left.name === frame.name) {
          context.report({
            node,
            messageId: "inheritedKey",
            data: { key: frame.name },
          });
          return;
        }
        if (node.left.type === "Literal" && node.right.type === "Identifier")
          frame.presence.push({
            node,
            object: node.right.name,
            key: String(node.left.value),
          });
      },
    };
  },
});
