import { defineRule } from "@oxlint/plugins";

import { JSDOC_TYPED_FILE } from "../../anti-slop/shared/type-guards.ts";

import type { Comment, ESTree, SourceCode } from "@oxlint/plugins";

/**
 * Where a node of this type may carry TSDoc. A `module` declaration is a statement and
 * documents only at module level, so a block before a local `const` is reported. A `member`
 * documents wherever it appears.
 */
const DOCUMENTED_KINDS: ReadonlyMap<string, "module" | "member"> = new Map([
  ["FunctionDeclaration", "module"],
  ["ClassDeclaration", "module"],
  ["VariableDeclaration", "module"],
  ["TSInterfaceDeclaration", "module"],
  ["TSTypeAliasDeclaration", "module"],
  ["TSEnumDeclaration", "module"],
  ["TSModuleDeclaration", "module"],
  ["TSDeclareFunction", "module"],
  ["ExportNamedDeclaration", "module"],
  ["ExportDefaultDeclaration", "module"],
  ["ExportAllDeclaration", "module"],
  ["TSExportAssignment", "module"],
  ["MethodDefinition", "member"],
  ["PropertyDefinition", "member"],
  ["AccessorProperty", "member"],
  ["TSAbstractMethodDefinition", "member"],
  ["TSAbstractPropertyDefinition", "member"],
  ["TSAbstractAccessorProperty", "member"],
  ["TSPropertySignature", "member"],
  ["TSMethodSignature", "member"],
  ["TSIndexSignature", "member"],
  ["TSCallSignatureDeclaration", "member"],
  ["TSConstructSignatureDeclaration", "member"],
  ["TSEnumMember", "member"],
  ["Property", "member"],
  ["TSParameterProperty", "member"],
]);
const MODULE_LEVEL_PARENTS: ReadonlySet<string> = new Set([
  "Program",
  "ExportNamedDeclaration",
  "ExportDefaultDeclaration",
  "TSModuleBlock",
]);
const MODULE_DOC_TAG =
  /(?:^|\s)@(?:packageDocumentation|module|fileoverview)\b/u;
const JS_TYPE_TAG =
  /(?:^|\s)@(?:typedef|callback|import|type|param|returns?|template|satisfies|this|enum|property|extends|augments|implements|overload)\b/u;

const allowedCommentForms = [
  { type: "Shebang", pattern: /^/u },
  { type: "Block", pattern: /^!/u, raw: true },
  { type: "Line", pattern: /^\/\s*<reference\s[^>]*\/\s*>\s*$/u },
  { type: null, pattern: /^(?:oxlint|eslint)-enable(?:\s|$)/u },
  {
    type: null,
    pattern: /^(?:oxlint|eslint)-disable(?:-line|-next-line)?\s+(?!-)[\w@/]/u,
  },
  { type: null, pattern: /^@ts-expect-error(?:\s*:\s*|\s+)(?!:)\S/u },
  { type: null, pattern: /^SAFETY:/u, safety: true },
  { type: null, pattern: /^(?:#|@)__PURE__\s*$/u },
  { type: null, pattern: /^@vite-ignore\b/u },
  {
    type: null,
    pattern:
      /^webpack(?:ChunkName|Prefetch|Preload|Mode|Ignore|Exports|Include|Exclude)\s*:/u,
  },
  { type: null, pattern: /^(?:prettier|oxfmt)-ignore\s*$/u },
  { type: null, pattern: /^@vitest-environment\s+\S+$/u, fileStart: true },
];
const attachedDoc = { type: "Block" } as const;
const disableDirective =
  /^(?:oxlint|eslint)-disable(?:-line|-next-line)?(?:\s|$)/u;

function isDocBlock(comment: Comment): boolean {
  return comment.type === "Block" && comment.value.startsWith("*");
}

/**
 * Whether no token precedes `comment` in its script. vue-eslint-parser opens each `.vue` script
 * block with a `<script>` punctuator, which oxlint, linting the block alone, never sees.
 */
function startsScript(sourceCode: SourceCode, comment: Comment): boolean {
  const token = sourceCode.getTokenBefore(comment);
  return (
    token === null ||
    (token.type === "Punctuator" && token.value === "<script>")
  );
}

/**
 * The token `comment` documents: the next token, past directive comments, with no blank line
 * and no other `/**` block on the way.
 */
function documentedToken(
  sourceCode: SourceCode,
  comment: Comment,
): ESTree.Token | null {
  const token = sourceCode.getTokenAfter(comment);
  if (token === null) return null;
  const between = sourceCode
    .getCommentsBefore(token)
    .filter((other) => other.range[0] >= comment.range[1]);
  const chain = [comment, ...between, token];
  const separated = chain
    .slice(1)
    .some((item, index) =>
      /\n[^\S\n]*\n/u.test(
        sourceCode.text.slice(chain[index]?.range[1], item.range[0]),
      ),
    );
  return separated || between.some(isDocBlock) ? null : token;
}

/**
 * Whether a declaration of `DOCUMENTED_KINDS` starts at the token `comment` documents or an ancestor of that token.
 * A decorator written before `export` lies outside the range of its class, so decorators are looked up by start.
 */
function documentsDeclaration(
  sourceCode: SourceCode,
  decorators: ReadonlyMap<number, ESTree.Decorator>,
  comment: Comment,
): boolean {
  const token = documentedToken(sourceCode, comment);
  if (token === null) return false;
  let node: ESTree.Node | null =
    decorators.get(token.range[0]) ??
    sourceCode.getNodeByRangeIndex(token.range[0]);
  while (node !== null && node.range[0] >= comment.range[1]) {
    const scope = DOCUMENTED_KINDS.get(node.type);
    const parent: ESTree.Node | null = node.parent;
    if (
      scope === "member" ||
      (scope === "module" &&
        parent !== null &&
        MODULE_LEVEL_PARENTS.has(parent.type))
    )
      return true;
    node = parent;
  }
  return false;
}

/**
 * Whether a `/**` block needs no declaration: a module doc that opens the file, or in a
 * JavaScript file a JSDoc type annotation, which is that file's type system wherever it sits.
 */
function isStandaloneDoc(
  sourceCode: SourceCode,
  comment: Comment,
  filename: string,
): boolean {
  if (MODULE_DOC_TAG.test(comment.value) && startsScript(sourceCode, comment))
    return true;
  return JSDOC_TYPED_FILE.test(filename) && JS_TYPE_TAG.test(comment.value);
}

/** Ordinary comments must become executable constraints or TSDoc on the declaration it documents. */
export const noCommentsRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow comments except TSDoc on a declaration and explicit compiler or safety directives.",
    },
    messages: {
      comment:
        "Comments rot. Encode this constraint in a type, a lint rule, or a test, or write TSDoc (`/** */`) on the declaration it documents.",
      detachedDoc:
        "TSDoc (`/** */`) belongs on the declaration it documents. Move it there, or encode this constraint in a type, a lint rule, or a test.",
      unnamedDisable:
        "Name the rule(s) to disable and give a reason, for example: oxlint-disable-next-line no-debugger -- debugging this operation.",
    },
  },
  createOnce(context) {
    const decorators = new Map<number, ESTree.Decorator>();
    return {
      before() {
        decorators.clear();
      },
      Decorator(node) {
        decorators.set(node.range[0], node);
      },
      "Program:exit"() {
        const { sourceCode, filename } = context;
        let safetyLine: Comment | undefined;
        for (const comment of sourceCode.getAllComments()) {
          const text = comment.value.replace(/^\s*\*?\s*/u, "").trimEnd();
          const isDoc = isDocBlock(comment);
          const form =
            isDoc &&
            (documentsDeclaration(sourceCode, decorators, comment) ||
              isStandaloneDoc(sourceCode, comment, filename))
              ? attachedDoc
              : allowedCommentForms.find(
                  (allowed) =>
                    (allowed.type === null || allowed.type === comment.type) &&
                    (!("fileStart" in allowed) ||
                      startsScript(sourceCode, comment)) &&
                    allowed.pattern.test(
                      "raw" in allowed ? comment.value : text,
                    ),
                );
          const continuesSafety =
            comment.type === "Line" &&
            safetyLine !== undefined &&
            comment.loc.start.line === safetyLine.loc.end.line + 1 &&
            /^\s*$/u.test(
              sourceCode.text.slice(safetyLine.range[1], comment.range[0]),
            );
          safetyLine =
            comment.type === "Line" &&
            (continuesSafety || (form !== undefined && "safety" in form))
              ? comment
              : undefined;
          const unnamedDisable =
            disableDirective.test(text) && form === undefined;
          if (!unnamedDisable && (form !== undefined || continuesSafety))
            continue;
          context.report({
            loc: comment.loc,
            messageId: unnamedDisable
              ? "unnamedDisable"
              : isDoc
                ? "detachedDoc"
                : "comment",
          });
        }
      },
    };
  },
});
