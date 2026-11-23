import { defineRule } from "@oxlint/plugins";

import { JSDOC_TYPED_FILE, jsDocTagType } from "../shared/type-guards.ts";

import type { Comment, ESTree, SourceCode, Token } from "@oxlint/plugins";

type TypeAssertion =
  | ESTree.TSAsExpression
  | ESTree.TSTypeAssertion
  | ESTree.TSNonNullExpression;

export const DEFAULT_SAFETY_MARKERS = ["SAFETY"] as const;

const classMemberKinds: ReadonlySet<string> = new Set([
  "AccessorProperty",
  "MethodDefinition",
  "PropertyDefinition",
  "StaticBlock",
  "TSAbstractAccessorProperty",
  "TSAbstractMethodDefinition",
  "TSAbstractPropertyDefinition",
  "TSIndexSignature",
]);

/** Whether `node` is a statement, a declaration or a class member. */
function isStatementLike(node: ESTree.Node): boolean {
  return (
    node.type.endsWith("Statement") ||
    node.type.endsWith("Declaration") ||
    classMemberKinds.has(node.type)
  );
}

function isConstAssertion(node: TypeAssertion): boolean {
  return (
    node.type !== "TSNonNullExpression" &&
    node.typeAnnotation.type === "TSTypeReference" &&
    node.typeAnnotation.typeName.type === "Identifier" &&
    node.typeAnnotation.typeName.name === "const"
  );
}

function configuredSafetyMarkers(option: unknown): readonly string[] {
  if (typeof option !== "object" || option === null || !("markers" in option)) {
    return DEFAULT_SAFETY_MARKERS;
  }
  const configured = option.markers;
  if (!Array.isArray(configured)) return DEFAULT_SAFETY_MARKERS;
  const markers = configured.flatMap((marker) =>
    typeof marker === "string" && marker.trim().length > 0 ? [marker.trim()] : [],
  );
  return markers.length > 0 ? markers : DEFAULT_SAFETY_MARKERS;
}

export function markerPattern(markers: readonly string[]): RegExp {
  const alternation = markers
    .map((marker) => marker.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`))
    .join("|");
  return new RegExp(
    String.raw`(?:^|[^\p{L}\p{N}_])(?:${alternation})\s*:\s*\S`,
    "u",
  );
}

/** A JSDoc cast: its `(` and the innermost node containing that `(`. */
interface JsDocCast {
  readonly paren: Token;
  readonly owner: ESTree.Node;
}

/**
 * Return the cast a JSDoc `@type {T}` block makes of the parenthesized expression after it,
 * unless `T` is `const` or the `(` opens the parameters of an annotated arrow function.
 */
function jsDocCast(sourceCode: SourceCode, comment: Comment): JsDocCast | null {
  if (comment.type !== "Block" || !comment.value.startsWith("*")) return null;
  const type = jsDocTagType(comment.value, "type");
  if (type === null || type.trim() === "const") return null;
  const paren = sourceCode.getTokenAfter(comment);
  if (paren?.type !== "Punctuator" || paren.value !== "(") return null;
  const owner = sourceCode.getNodeByRangeIndex(paren.range[0]);
  if (owner === null) return null;
  const annotatesArrow =
    owner.type === "ArrowFunctionExpression" && owner.range[0] === paren.range[0];
  return annotatesArrow ? null : { paren, owner };
}

/**
 * Return whether a marker comment ends before `assertion` starts, either right before it
 * or before a node from `owner` up to its innermost statement, declaration or class member.
 */
function hasSafetyComment(
  sourceCode: SourceCode,
  assertion: TypeAssertion | Comment,
  owner: ESTree.Node,
  pattern: RegExp,
): boolean {
  const justifies = (target: ESTree.Node | Comment): boolean =>
    sourceCode
      .getCommentsBefore(target)
      .some(
        (comment) =>
          comment.range[1] <= assertion.range[0] && pattern.test(comment.value),
      );
  if (justifies(assertion)) return true;
  let current = owner;
  while (current.type !== "Program") {
    if (justifies(current)) return true;
    if (isStatementLike(current)) {
      const exportDeclaration = current.parent;
      return (
        (exportDeclaration.type === "ExportNamedDeclaration" ||
          exportDeclaration.type === "ExportDefaultDeclaration") &&
        exportDeclaration.declaration === current &&
        justifies(exportDeclaration)
      );
    }
    current = current.parent;
  }
  return false;
}

/** Require every non-const type assertion and every non-null assertion (`x!`), JSDoc casts in JavaScript files included, to state the invariant TypeScript cannot express. */
export const requireSafetyCommentForTypeAssertionRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Require a nearby SAFETY comment for every type assertion and non-null assertion, TypeScript or JSDoc cast, except const assertions.",
    },
    messages: {
      missingSafetyComment:
        "This type or non-null assertion has no `{{marker}}:` justification. State the checked invariant immediately before the assertion or its containing statement.",
    },
    schema: [
      {
        type: "object",
        properties: {
          markers: {
            type: "array",
            items: { type: "string", minLength: 1 },
            minItems: 1,
            uniqueItems: true,
          },
        },
        additionalProperties: false,
      },
    ],
    defaultOptions: [{ markers: ["SAFETY"] }],
  },
  createOnce(context) {
    const patterns = new Map<string, RegExp>();

    const markerSettings = () => {
      const markers = configuredSafetyMarkers(context.options?.[0]);
      const patternKey = markers.join("\u0000");
      const pattern = patterns.get(patternKey) ?? markerPattern(markers);
      patterns.set(patternKey, pattern);
      return { pattern, data: { marker: markers[0] ?? DEFAULT_SAFETY_MARKERS[0] } };
    };

    const checkAssertion = (node: TypeAssertion) => {
      if (isConstAssertion(node)) return;
      const { pattern, data } = markerSettings();
      if (node.parent === null || hasSafetyComment(context.sourceCode, node, node.parent, pattern)) {
        return;
      }
      context.report({ node, messageId: "missingSafetyComment", data });
    };

    const checkJsDocCasts = () => {
      if (!JSDOC_TYPED_FILE.test(context.filename)) return;
      const { sourceCode } = context;
      const { pattern, data } = markerSettings();
      const castParens = new Set<number>();
      for (const comment of sourceCode.getAllComments()) {
        const cast = jsDocCast(sourceCode, comment);
        if (cast === null || castParens.has(cast.paren.range[0])) continue;
        castParens.add(cast.paren.range[0]);
        if (hasSafetyComment(sourceCode, comment, cast.owner, pattern)) continue;
        context.report({
          loc: { start: comment.loc.start, end: cast.paren.loc.end },
          messageId: "missingSafetyComment",
          data,
        });
      }
    };

    return {
      Program: checkJsDocCasts,
      TSAsExpression: checkAssertion,
      TSNonNullExpression: checkAssertion,
      TSTypeAssertion: checkAssertion,
    };
  },
});
