import { readFileSync } from "node:fs";
import { defineRule } from "@oxlint/plugins";
import ts from "@typescript/typescript6";

import { typedFile, type TypedFile } from "../type-checker.ts";
import { declaresTypeParameters, scriptView } from "../vue-script.ts";

const UNTYPED = ts.TypeFlags.Any | ts.TypeFlags.Unknown;

/** Which `typescript/no-unsafe-*` rule a finding stands in for. */
type Unsafe = "assignment" | "argument" | "return";

interface Finding {
  kind: Unsafe;
  node: ts.Node;
}

/** Whether `node` is typed `any` itself, not an error type from an import the program cannot resolve, such as another component. */
function isAny(checker: ts.TypeChecker, node: ts.Node): boolean {
  return checker.getTypeAtLocation(node) === checker.getAnyType();
}

function takesAnything(type: ts.Type | undefined): boolean {
  return type === undefined || (type.flags & UNTYPED) !== 0;
}

function declaredReturn(
  checker: ts.TypeChecker,
  node: ts.Node,
): ts.Type | undefined {
  let owner = node.parent;
  while (!ts.isFunctionLike(owner)) {
    if (ts.isSourceFile(owner)) return undefined;
    owner = owner.parent;
  }
  const contextual = ts.isExpression(owner)
    ? checker.getContextualType(owner)
    : undefined;
  const declared =
    owner.type === undefined
      ? contextual &&
        checker
          .getNonNullableType(contextual)
          .getCallSignatures()[0]
          ?.getReturnType()
      : checker.getTypeFromTypeNode(owner.type);
  const isAsync =
    ts.canHaveModifiers(owner) &&
    ts
      .getModifiers(owner)
      ?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword);
  return declared && isAsync ? checker.getAwaitedType(declared) : declared;
}

function argumentFindings(
  checker: ts.TypeChecker,
  call: ts.CallExpression | ts.NewExpression,
): Finding[] {
  return (call.arguments ?? []).flatMap((argument) =>
    ts.isSpreadElement(argument) ||
    !isAny(checker, argument) ||
    takesAnything(checker.getContextualType(argument))
      ? []
      : [{ kind: "argument", node: argument }],
  );
}

function returned(checker: ts.TypeChecker, value: ts.Expression): Finding[] {
  const declared = declaredReturn(checker, value);
  return isAny(checker, value) &&
    (declared === undefined || !takesAnything(declared))
    ? [{ kind: "return", node: value }]
    : [];
}

function nodeFindings(checker: ts.TypeChecker, node: ts.Node): Finding[] {
  if (ts.isVariableDeclaration(node) && node.initializer !== undefined)
    return isAny(checker, node.initializer) &&
      !(
        node.type !== undefined &&
        takesAnything(checker.getTypeAtLocation(node.name))
      )
      ? [{ kind: "assignment", node }]
      : [];
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.EqualsToken
  )
    return isAny(checker, node.right) &&
      !takesAnything(checker.getTypeAtLocation(node.left))
      ? [{ kind: "assignment", node }]
      : [];
  if (ts.isCallExpression(node) || ts.isNewExpression(node))
    return argumentFindings(checker, node);
  if (ts.isReturnStatement(node) && node.expression !== undefined)
    return returned(checker, node.expression);
  if (ts.isArrowFunction(node) && !ts.isBlock(node.body))
    return returned(checker, node.body);
  return [];
}

function findings({ checker, sourceFile }: TypedFile): Finding[] {
  const found: Finding[] = [];
  function visit(node: ts.Node): void {
    found.push(...nodeFindings(checker, node));
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return found;
}

/**
 * `typescript/no-unsafe-assignment`, `no-unsafe-argument` and
 * `no-unsafe-return` for the script blocks of a `.vue` file, which
 * oxlint-tsgolint cannot read. TypeScript files stay with tsgolint, and a
 * component with `generic` type parameters is skipped, as only Vue's compiler
 * brings them into scope.
 */
export const noUnsafeAnyInVueRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "A Vue component's script assigns, passes and returns no `any` where a type is declared.",
    },
    messages: {
      assignment:
        "Unsafe assignment of an `any` value, which `typescript/no-unsafe-assignment` reports in a TypeScript file. Use a typed value or `unknown`, and narrow it before use.",
      argument:
        "Unsafe argument of type `any` to a typed parameter, which `typescript/no-unsafe-argument` reports in a TypeScript file. Pass a typed value.",
      return:
        "Unsafe return of an `any` value from a function with a declared return type, which `typescript/no-unsafe-return` reports in a TypeScript file. Return a typed value.",
    },
  },
  createOnce(context) {
    return {
      Program() {
        const { filename, sourceCode } = context;
        if (!filename.endsWith(".vue")) return;
        const { text } = sourceCode;
        const component =
          scriptView(text) === undefined
            ? readFileSync(filename, "utf8")
            : text;
        const offset = component.indexOf(text);
        if (offset === -1 || declaresTypeParameters(component)) return;
        const typed = typedFile(filename, component);
        if (typed === undefined) return;
        for (const { kind, node } of findings(typed)) {
          const start = node.getStart(typed.sourceFile) - offset;
          const end = node.end - offset;
          if (start >= 0 && end <= text.length)
            context.report({
              messageId: kind,
              loc: {
                start: sourceCode.getLocFromIndex(start),
                end: sourceCode.getLocFromIndex(end),
              },
            });
        }
      },
    };
  },
});
