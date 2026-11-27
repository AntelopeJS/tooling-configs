import type { ESTree, SourceCode } from "@oxlint/plugins";
import ts from "../../typescript6.ts";

import { enclosingPackage } from "./self-package.ts";
import { resolveVariable, unwrapExpression } from "./local-types.ts";
import { nodeAt, typedFile } from "./type-checker.ts";
import { lintedSource } from "./vue-script.ts";

const ASSERT_STATUSES = new Set([403, 404, 409, 422]);
const DMS_PACKAGE = /^(@[^/]+\/)?(interface-)?dms(-|$)/;

/** Whether the package around `file` is a DMS module: its name or one of its dependencies is `dms-*`, `interface-dms` or `@scope/dms-*`. */
export function isDmsPackage(file: string): boolean {
  const manifest = enclosingPackage(file)?.manifest;
  if (manifest === undefined) return false;
  return [manifest.name, ...manifest.dependencyNames].some((name) =>
    DMS_PACKAGE.test(name),
  );
}

/** What an expression statically is: a text, with a placeholder segment at each template substitution (`exact` false), or a status number. */
export type Static =
  | { kind: "text"; text: string; exact: boolean }
  | { kind: "number"; value: number };

const SUBSTITUTION_PLACEHOLDER = "x";

function literalValue(literal: {
  raw?: string | null;
  value?: unknown;
}): Static | null {
  const raw = literal.raw ?? "";
  if (/^\d+$/.test(raw)) return { kind: "number", value: Number(raw) };
  return /^["']/.test(raw)
    ? { kind: "text", text: String(literal.value), exact: true }
    : null;
}

function templateValue(template: ESTree.TemplateLiteral): Static {
  return {
    kind: "text",
    text: template.quasis
      .map((quasi) => quasi.value.cooked ?? "")
      .join(SUBSTITUTION_PLACEHOLDER),
    exact: template.expressions.length === 0,
  };
}

/** The value of a literal, a template literal or a `const` initialised with one, or null when it is not static. */
function staticValue(
  node: ESTree.Node,
  source: SourceCode,
  seen = new Set<string>(),
): Static | null {
  if (
    node.type === "ParenthesizedExpression" ||
    node.type === "TSNonNullExpression" ||
    node.type === "TSAsExpression" ||
    node.type === "TSSatisfiesExpression"
  )
    return staticValue(node.expression, source, seen);
  const expression = node;
  if (expression.type === "Literal") return literalValue(expression);
  if (expression.type === "TemplateLiteral") return templateValue(expression);
  if (expression.type !== "Identifier" || seen.has(expression.name))
    return null;
  const [definition] = resolveVariable(source, expression)?.defs ?? [];
  if (
    definition?.type !== "Variable" ||
    definition.parent?.type !== "VariableDeclaration" ||
    definition.parent.kind !== "const" ||
    definition.node.type !== "VariableDeclarator" ||
    definition.node.init === null
  )
    return null;
  seen.add(expression.name);
  return staticValue(definition.node.init, source, seen);
}

/** A text a refusal message can hold. */
type Text = Extract<Static, { kind: "text" }>;

/** What a rule's context gives the refusal helpers: the linted file and its source. */
export interface RefusalContext {
  readonly filename: string;
  readonly sourceCode: SourceCode;
}

function literalTypes(message: ESTree.Node, context: RefusalContext): Text[] {
  const linted = lintedSource(context.filename, context.sourceCode.text);
  const typed = linted && typedFile(context.filename, linted.text);
  if (linted === undefined || typed === undefined) return [];
  const [start, end] = message.range;
  const expression = nodeAt(
    typed.sourceFile,
    { range: [start + linted.offset, end + linted.offset] },
    ts.isExpression,
  );
  if (expression === undefined) return [];
  const type = typed.checker.getTypeAtLocation(expression);
  return (type.isUnion() ? type.types : [type]).flatMap((member): Text[] =>
    member.isStringLiteral()
      ? [{ kind: "text", text: member.value, exact: true }]
      : [],
  );
}

/** The texts a refusal message can hold: its static value, otherwise each string literal its type allows, as a member of an `as const` object read from this file or another one has. Empty when neither tells. */
export function messageTexts(
  message: ESTree.Node,
  context: RefusalContext,
): Text[] {
  const value = staticValue(message, context.sourceCode);
  if (value !== null) return value.kind === "text" ? [value] : [];
  return literalTypes(message, context);
}

function messageOf(argument: ESTree.Argument | undefined): ESTree.Node | null {
  if (argument === undefined || argument.type === "SpreadElement") return null;
  const expression = unwrapExpression(argument);
  if (expression.type !== "ObjectExpression") return expression;
  for (const property of expression.properties) {
    if (
      property.type === "Property" &&
      !property.computed &&
      ((property.key.type === "Identifier" &&
        property.key.name === "message") ||
        (property.key.type === "Literal" && property.key.value === "message"))
    )
      return property.value;
  }
  return null;
}

/** The name a callee is exported under: the imported name of an `import { assert as alias }`, otherwise its own name. */
function calleeName(callee: ESTree.Node, source: SourceCode): string | null {
  if (callee.type !== "Identifier") return null;
  const [definition] = resolveVariable(source, callee)?.defs ?? [];
  if (
    definition?.type !== "ImportBinding" ||
    definition.node.type !== "ImportSpecifier"
  )
    return callee.name;
  const { imported } = definition.node;
  return imported.type === "Identifier"
    ? imported.name
    : String(imported.value);
}

/** Visitors that call `onRefusal` with the message of each `assert(cond, 403|404|409|422, message)` and `new HTTPResult(4xx, message)`, aliased imports included. */
export function refusalVisitors(
  context: RefusalContext,
  onRefusal: (message: ESTree.Node) => void,
) {
  function check(
    status: ESTree.Argument | undefined,
    message: ESTree.Node | null,
    accepts: (code: number) => boolean,
  ) {
    if (message === null) return;
    if (status === undefined || status.type === "SpreadElement") return;
    const code = staticValue(status, context.sourceCode);
    if (code?.kind === "number" && accepts(code.value)) onRefusal(message);
  }
  return {
    CallExpression(node: ESTree.CallExpression) {
      if (calleeName(node.callee, context.sourceCode) !== "assert") return;
      check(node.arguments[1], messageOf(node.arguments[2]), (code) =>
        ASSERT_STATUSES.has(code),
      );
    },
    NewExpression(node: ESTree.NewExpression) {
      if (calleeName(node.callee, context.sourceCode) !== "HTTPResult") return;
      check(
        node.arguments[0],
        messageOf(node.arguments[1]),
        (code) => code >= 400 && code < 500,
      );
    },
  };
}
