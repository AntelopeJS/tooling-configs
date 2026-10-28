import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuleTester } from "oxlint/plugins-dev";

import { noSelfImportInTestsRule } from "./no-self-import-in-tests.ts";

const NAME = "@antelopejs/interface-demo";
const EXPORTS = {
  ".": { types: "./dist/index.d.ts", default: "./dist/index.js" },
  "./tests/*": { default: "./dist/tests/*.js" },
  "./package.json": "./package.json",
};

function packageAt(root: string, manifest: string, linked: boolean): string {
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "package.json"), manifest);
  if (linked) {
    mkdirSync(join(root, "node_modules/@antelopejs"), { recursive: true });
    symlinkSync(root, join(root, "node_modules", NAME), "dir");
  }
  return join(root, "src/index.test.ts");
}

const base = mkdtempSync(join(tmpdir(), "antelope-self-import-"));
const unlinked = packageAt(
  join(base, "unlinked"),
  JSON.stringify({ name: NAME, exports: EXPORTS }),
  false,
);
const linked = packageAt(
  join(base, "linked"),
  JSON.stringify({ name: NAME, exports: EXPORTS }),
  true,
);
const linkedWithoutExports = packageAt(
  join(base, "no-exports"),
  JSON.stringify({ name: NAME }),
  true,
);
const linkedPartialExports = packageAt(
  join(base, "partial"),
  JSON.stringify({ name: NAME, exports: { ".": "./dist/index.js" } }),
  true,
);
const nested = join(base, "workspace");
mkdirSync(join(nested, "packages/inner/src"), { recursive: true });
writeFileSync(
  join(nested, "package.json"),
  JSON.stringify({ name: "workspace-root", private: true }),
);
const workspaceMember = packageAt(
  join(nested, "packages/inner"),
  JSON.stringify({ name: "@antelopejs/inner", exports: EXPORTS }),
  false,
);

const tester = new RuleTester({
  languageOptions: { parserOptions: { lang: "ts" } },
});
const error = { messageId: "selfImport" };

tester.run("antelopejs/no-self-import-in-tests", noSelfImportInTestsRule, {
  valid: [
    { code: `import { run } from "..";`, filename: unlinked },
    { code: `import { run } from "../index";`, filename: unlinked },
    {
      code: `import { other } from "@antelopejs/interface-other";`,
      filename: unlinked,
    },
    { code: `import { x } from "${NAME}-extras";`, filename: unlinked },
    { code: `import type { Run } from "${NAME}";`, filename: unlinked },
    { code: `import { type Run } from "${NAME}";`, filename: unlinked },
    { code: `export type { Run } from "${NAME}";`, filename: unlinked },
    { code: `import { run } from "${NAME}";`, filename: linked },
    {
      code: `import { helper } from "${NAME}/tests/helper";`,
      filename: linked,
    },
    { code: `const { run } = require("${NAME}");`, filename: linked },
    {
      code: `import { run } from "@antelopejs/interface-demo";`,
      filename: "/nonexistent/dir/a.test.ts",
    },
    {
      code: `import { run } from "${NAME}";`,
      filename: join(nested, "root.test.ts"),
    },
  ],
  invalid: [
    {
      name: "interface-redis@a1b7dd4:src/tests/index.test.ts:2",
      code: `import { expect } from "chai";\nimport { GetClient } from "${NAME}";`,
      filename: unlinked,
      errors: [error],
    },
    { code: `import "${NAME}";`, filename: unlinked, errors: [error] },
    {
      code: `import * as demo from "${NAME}/tests/helper";`,
      filename: unlinked,
      errors: [error],
    },
    {
      code: `export { run } from "${NAME}";`,
      filename: unlinked,
      errors: [error],
    },
    { code: `export * from "${NAME}";`, filename: unlinked, errors: [error] },
    {
      code: `const demo = await import("${NAME}");`,
      filename: unlinked,
      errors: [error],
    },
    {
      code: `const demo = require("${NAME}");`,
      filename: unlinked,
      errors: [error],
    },
    {
      code: `import demo = require("${NAME}");`,
      filename: unlinked,
      errors: [error],
    },
    {
      code: `import { run, type Run } from "${NAME}";`,
      filename: unlinked,
      errors: [error],
    },
    {
      name: "a self-link without an exports map does not publish the subpath",
      code: `import { run } from "${NAME}";`,
      filename: linkedWithoutExports,
      errors: [error],
    },
    {
      name: "the exports map must publish the imported subpath",
      code: `import { helper } from "${NAME}/tests/helper";`,
      filename: linkedPartialExports,
      errors: [error],
    },
    {
      name: "a workspace member is judged by its own manifest, not the root",
      code: `import { run } from "@antelopejs/inner";`,
      filename: workspaceMember,
      errors: [error],
    },
  ],
});
