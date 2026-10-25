import { defineRule } from "@oxlint/plugins";

const allowedCommentPatterns = [
  /^(?:oxlint|eslint)-(?:disable|enable)(?:\b|[-\s])/u,
  /^@ts-expect-error(?:\s*:\s*|\s+)(?!:)\S/u,
  /^SAFETY:/u,
];
const referenceDirective = /^\/\s*<reference\s[^>]*\/\s*>\s*$/u;

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
    },
  },
  createOnce(context) {
    return {
      Program() {
        for (const comment of context.sourceCode.getAllComments()) {
          if (comment.type === "Shebang") continue;
          if (comment.type === "Block" && comment.value.startsWith("*"))
            continue;
          if (
            comment.type === "Line" &&
            referenceDirective.test(comment.value.trim())
          )
            continue;
          if (
            allowedCommentPatterns.some((pattern) =>
              pattern.test(comment.value.trim()),
            )
          )
            continue;
          context.report({ loc: comment.loc, messageId: "comment" });
        }
      },
    };
  },
});
