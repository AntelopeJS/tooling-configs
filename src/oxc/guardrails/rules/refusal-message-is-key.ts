import { defineRule } from "@oxlint/plugins";

import type { ESTree, SourceCode } from "@oxlint/plugins";
import { isDmsPackage, refusalVisitors, staticValue } from "../refusals.ts";

const TRANSLATION_KEY = /^\$?[A-Za-z0-9_-]+(\.[A-Za-z0-9_]+)+$/;

function isSentence(node: ESTree.Node, source: SourceCode): boolean {
  const value = staticValue(node, source);
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
    const visitors = refusalVisitors(context, (message) => {
      if (dms && isSentence(message, context.sourceCode))
        context.report({ node: message, messageId: "sentence" });
    });
    return {
      before() {
        dms = isDmsPackage(context.filename);
      },
      ...visitors,
    };
  },
});
