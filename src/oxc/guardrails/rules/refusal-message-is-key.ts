import { defineRule } from "@oxlint/plugins";

import type { ESTree, SourceCode } from "@oxlint/plugins";
import { enclosingPackage } from "../self-package.ts";
import { resolveVariable, unwrapExpression } from "../local-types.ts";

const ASSERT_STATUSES = new Set([403, 404, 409, 422]);
const TRANSLATION_KEY = /^\$?[A-Za-z0-9_-]+(\.[a-z0-9_]+)+$/;
const DMS_PACKAGE = /^(@[^/]+\/)?(interface-)?dms(-|$)/;

function isDmsPackage(file: string): boolean {
  const manifest = enclosingPackage(file)?.manifest;
  if (manifest === undefined) return false;
  return [manifest.name, ...manifest.dependencyNames].some((name) =>
    DMS_PACKAGE.test(name),
  );
}

/** What an expression statically is: a sentence-bearing text, a status number, or a template that interpolates. */
type Static =
  | { kind: "text"; text: string }
  | { kind: "number"; value: number }
  | { kind: "interpolated" };

function literalValue(literal: {
  raw?: string | null;
  value?: unknown;
}): Static | null {
  const raw = literal.raw ?? "";
  if (/^\d+$/.test(raw)) return { kind: "number", value: Number(raw) };
  return /^["']/.test(raw)
    ? { kind: "text", text: String(literal.value) }
    : null;
}

function templateValue(template: ESTree.TemplateLiteral): Static {
  return template.expressions.length > 0
    ? { kind: "interpolated" }
    : { kind: "text", text: template.quasis[0]?.value.cooked ?? "" };
}

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

function isSentence(node: ESTree.Node, source: SourceCode): boolean {
  const value = staticValue(node, source);
  if (value?.kind === "interpolated") return true;
  return value?.kind === "text" && !TRANSLATION_KEY.test(value.text);
}

/** A 4xx refusal reaches the DMS error presenter, which reads its message as a translation key, so a sentence there shows untranslated. */
export const refusalMessageIsKeyRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Require the message of a 4xx refusal to be a translation key.",
    },
    messages: {
      sentence:
        "This refusal reaches the DMS error presenter, which reads message as a translation key. Add the sentence to the locale files and pass $<module>.<key> with its params (see dms-database src/service/connectionRefusals.ts).",
    },
  },
  createOnce(context) {
    let dms = false;
    function check(
      status: ESTree.Argument | undefined,
      message: ESTree.Node | null,
      accepts: (code: number) => boolean,
    ) {
      if (!dms) return;
      if (status === undefined || status.type === "SpreadElement") return;
      const code = staticValue(status, context.sourceCode);
      if (code?.kind !== "number" || !accepts(code.value)) return;
      if (message !== null && isSentence(message, context.sourceCode))
        context.report({ node: message, messageId: "sentence" });
    }
    return {
      before() {
        dms = isDmsPackage(context.filename);
      },
      CallExpression(node) {
        if (node.callee.type !== "Identifier" || node.callee.name !== "assert")
          return;
        check(node.arguments[1], messageOf(node.arguments[2]), (code) =>
          ASSERT_STATUSES.has(code),
        );
      },
      NewExpression(node) {
        if (
          node.callee.type !== "Identifier" ||
          node.callee.name !== "HTTPResult"
        )
          return;
        check(
          node.arguments[0],
          messageOf(node.arguments[1]),
          (code) => code >= 400 && code < 500,
        );
      },
    };
  },
});
