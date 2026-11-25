import { defineRule, type ESTree } from "@oxlint/plugins";
import ts from "../../../typescript6.ts";

import { programConfig, project, resolves } from "../tsconfig-program.ts";
import { nodeAt, typedFile } from "../type-checker.ts";

const TYPE_LINTED = /\.[cm]?[jt]sx?$/u;

/** The files tsc reports an unresolved import in: TypeScript and Vue components, not JavaScript, which tsc leaves unchecked without `checkJs`. */
const IMPORT_CHECKED = /\.(?:[cm]?ts|tsx|vue)$/u;

/** A component import, which only Volar resolves: no tsconfig can, so a report would ask for a fix that does not exist. */
const COMPONENT = /\.vue$/u;

/** The statements that make a script a module whatever `moduleDetection` says. */
const MODULE_STATEMENTS = new Set([
  "ImportDeclaration",
  "ExportNamedDeclaration",
  "ExportDefaultDeclaration",
  "ExportAllDeclaration",
]);

/** Whether `config` reads a `.vue` script that declares a name but has no import or export as a global script, whose declarations share one scope with every other such file of the program. */
function readsGlobalScript(config: string, program: ESTree.Program): boolean {
  return (
    project(config)?.options.moduleDetection !== ts.ModuleDetectionKind.Force &&
    !program.body.some((statement) => MODULE_STATEMENTS.has(statement.type)) &&
    program.body.some((statement) => statement.type.endsWith("Declaration"))
  );
}

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
      script:
        'The tsconfig that lists this component does not set `compilerOptions.moduleDetection` to `"force"`, so TypeScript reads this script, which imports nothing, as a global script: a name it declares, such as `props`, resolves to the same name in any other such component of the program, which TypeScript reads as raw text, so `typescript/no-unsafe-*` reports on it are false. Set `"moduleDetection": "force"` in that tsconfig, as the generated `.nuxt/tsconfig.json` does.',
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
        if (
          COMPONENT.test(context.filename) &&
          config !== undefined &&
          readsGlobalScript(config, node)
        )
          context.report({ node, messageId: "script" });
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
