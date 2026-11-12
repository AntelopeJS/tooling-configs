import ts from "@typescript/typescript6";

import {
  jsonRoot,
  propertyNamed,
  readText,
  stringValues,
  type CoverageFiles,
} from "./coverage-files.ts";

/** The release-it hooks that run before anything is published: the generic and plugin-scoped `init`, `bump` and `beforeRelease` stages, and `before` the `release` stage. */
const BEFORE_PUBLISH =
  /^(?:(?:before|after):(?:[^:]+:)?(?:init|bump|beforeRelease)|before:(?:[^:]+:)?release)$/u;

function hooksIn(
  files: CoverageFiles,
  file: string,
  path: readonly string[],
): string[] {
  const text = readText(files, file);
  if (text === undefined) return [];
  let node = jsonRoot(file, text);
  for (const key of path) node = propertyNamed(node, key);
  if (node === undefined || !ts.isObjectLiteralExpression(node)) return [];
  return node.properties.flatMap((property) =>
    ts.isPropertyAssignment(property) &&
    (ts.isStringLiteral(property.name) || ts.isIdentifier(property.name)) &&
    BEFORE_PUBLISH.test(property.name.text) &&
    propertyNamed(node, property.name.text) === property.initializer
      ? stringValues(property.initializer)
      : [],
  );
}

/** The commands of the release-it hooks that run before publishing, from `.release-it.json` and from the `release-it` key of `package.json`. Other config formats are not read. */
export function releaseHooks(files: CoverageFiles): string[] {
  return [
    ...hooksIn(files, ".release-it.json", ["hooks"]),
    ...hooksIn(files, "package.json", ["release-it", "hooks"]),
  ];
}
