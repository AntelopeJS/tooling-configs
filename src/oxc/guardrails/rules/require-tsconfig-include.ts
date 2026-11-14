import { defineRule, type ESTree } from "@oxlint/plugins";
import ts from "@typescript/typescript6";

import { programConfig, resolves } from "../tsconfig-program.ts";
import { nodeAt, typedFile } from "../type-checker.ts";

const TYPE_LINTED = /\.[cm]?[jt]sx?$/u;

/** The files tsc reports an unresolved import in: TypeScript and Vue components, not JavaScript, which tsc leaves unchecked without `checkJs`. */
const IMPORT_CHECKED = /\.(?:[cm]?ts|tsx|vue)$/u;

/** A component import, which only Volar resolves: no tsconfig can, so a report would ask for a fix that does not exist. */
const COMPONENT = /\.vue$/u;

function isStringLiteral(
  node: ESTree.Expression,
): node is ESTree.StringLiteral {
  return node.type === "Literal" && typeof node.value === "string";
}

/** Whether the program of `config` finds the module `source` names in `filename`, by file, package or ambient declaration. */
function moduleResolves(
  config: string,
  filename: string,
  text: string,
  source: ESTree.StringLiteral,
): boolean {
  if (resolves(config, source.value, filename)) return true;
  const typed = typedFile(filename, text);
  const literal = typed && nodeAt(typed.sourceFile, source, ts.isStringLiteral);
  return (
    typed === undefined ||
    literal === undefined ||
    typed.checker.getSymbolAtLocation(literal) !== undefined
  );
}

/** A file type-aware lint reads must be listed by a tsconfig, or tsgolint types it without the repository's compiler options and `types`; and that tsconfig must resolve its imports, or the program types everything imported through one as an error type. */
export const requireTsconfigIncludeRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Every file type-aware lint reads is listed by a tsconfig.json that resolves its imports, so its findings use the repository's compiler options and types.",
    },
    messages: {
      outside:
        "No tsconfig.json lists this file, so type-aware lint reads it in tsgolint's inferred program, without this repository's compiler options or `types`: Node and test-runner globals are error types, so `typescript/no-unsafe-*` reports here are false and findings that need those types go missing. List the file in a tsconfig.json that names the `types` it uses: one beside it that extends the root tsconfig, or, for a file at the root, a composite tsconfig that the root tsconfig references.",
      unresolved:
        "The tsconfig that lists this file cannot resolve `{{specifier}}`, so the program types everything imported from it as an error type: `typescript/no-unsafe-*` reports on those values are false and rules that need their types find none. List the file in a tsconfig that resolves the import: its `paths`, `baseUrl` or `node_modules` must reach the module. In a Nuxt layer that is a `tsconfig.json` that extends the generated `.nuxt/tsconfig.json`, with the lint script running `nuxt prepare` first.",
    },
  },
  createOnce(context) {
    let importConfig: string | undefined;
    function check(source: ESTree.StringLiteral): void {
      if (
        importConfig !== undefined &&
        !COMPONENT.test(source.value) &&
        !moduleResolves(
          importConfig,
          context.filename,
          context.sourceCode.text,
          source,
        )
      )
        context.report({
          node: source,
          messageId: "unresolved",
          data: { specifier: source.value },
        });
    }
    return {
      Program(node) {
        const config = programConfig(context.filename);
        importConfig = IMPORT_CHECKED.test(context.filename)
          ? config
          : undefined;
        if (TYPE_LINTED.test(context.filename) && config === undefined)
          context.report({ node, messageId: "outside" });
      },
      ImportDeclaration(node) {
        if (node.specifiers.length > 0) check(node.source);
      },
      ExportNamedDeclaration(node) {
        if (node.source !== null) check(node.source);
      },
      ExportAllDeclaration(node) {
        check(node.source);
      },
      ImportExpression(node) {
        if (isStringLiteral(node.source)) check(node.source);
      },
    };
  },
});
