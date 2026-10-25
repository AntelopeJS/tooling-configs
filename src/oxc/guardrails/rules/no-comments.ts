import { defineRule } from "@oxlint/plugins";

import type { Comment } from "@oxlint/plugins";

const allowedCommentForms = [
  { type: "Shebang", pattern: /^/u },
  { type: "Block", pattern: /^[*!]/u, raw: true },
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
];
const disableDirective =
  /^(?:oxlint|eslint)-disable(?:-line|-next-line)?(?:\s|$)/u;

/** Ordinary comments must become executable constraints or documentation on a public item. */
export const noCommentsRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow comments except documentation and explicit compiler or safety directives.",
    },
    messages: {
      comment:
        "Comments rot. Encode this constraint in a type, a lint rule, or a test, or write TSDoc (`/** */`) on the public item it documents.",
      unnamedDisable:
        "Name the rule(s) to disable and give a reason, for example: oxlint-disable-next-line no-debugger -- debugging this operation.",
    },
  },
  createOnce(context) {
    return {
      Program() {
        let safetyLine: Comment | undefined;
        for (const comment of context.sourceCode.getAllComments()) {
          const text = comment.value.replace(/^\s*\*?\s*/u, "").trimEnd();
          const form = allowedCommentForms.find(
            (allowed) =>
              (allowed.type === null || allowed.type === comment.type) &&
              allowed.pattern.test("raw" in allowed ? comment.value : text),
          );
          const continuesSafety =
            comment.type === "Line" &&
            safetyLine !== undefined &&
            comment.loc.start.line === safetyLine.loc.end.line + 1 &&
            /^\s*$/u.test(
              context.sourceCode.text.slice(safetyLine.end, comment.start),
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
            messageId: unnamedDisable ? "unnamedDisable" : "comment",
          });
        }
      },
    };
  },
});
