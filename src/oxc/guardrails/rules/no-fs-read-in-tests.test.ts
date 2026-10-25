import { RuleTester } from "oxlint/plugins-dev";

import { noFsReadInTestsRule } from "./no-fs-read-in-tests.ts";

const tester = new RuleTester({
  languageOptions: { parserOptions: { lang: "ts" } },
});
const error = { messageId: "fsRead" };

tester.run("antelopejs/no-fs-read-in-tests", noFsReadInTestsRule, {
  valid: [
    'import { writeFileSync } from "node:fs"; writeFileSync(path, result);',
    'import { readFileSync } from "./fixtures/reader"; readFileSync();',
    'import fs from "node:fs"; function use(fs: Reader) { fs.readFileSync(); }',
    "const fs = customReader; fs.readFileSync();",
    'import type { readFileSync } from "node:fs";',
    'import { type readFileSync } from "fs";',
    'import fs from "node:fs/promises"; fs.readFile("fixture");',
  ],
  invalid: [
    {
      name: "dms-saas@6303799:packages/dms-saas/test/layout-strip-reads.test.ts:1",
      code: `import { readFileSync } from "node:fs";
const STRIP_SOURCES = ["PastDueBanner.vue", "TrialEndingBanner.vue"].map(
  (file) =>
    readFileSync(
      new URL(\`../frontend-vue/app/components/\${file}\`, import.meta.url),
      "utf8",
    ),
);`,
      errors: [error],
    },
    {
      code: 'import { readdirSync as list } from "fs"; list(path);',
      errors: [error],
    },
    {
      code: 'import { readFileSync as read } from "node:fs"; read(path);',
      errors: [error],
    },
    {
      code: 'import * as fs from "fs"; fs.readFileSync(path);',
      errors: [error],
    },
    {
      code: 'import fs from "node:fs"; fs["readdirSync"](path);',
      errors: [error],
    },
    {
      code: 'import { default as fs } from "node:fs"; fs.readFileSync(path);',
      errors: [error],
    },
    {
      code: 'import fs = require("fs"); fs.readdirSync(path);',
      errors: [error],
    },
    {
      code: 'const { readFileSync: read } = require("fs"); read(path);',
      errors: [error],
    },
    {
      code: 'const { readdirSync, readFileSync } = require("node:fs");',
      errors: [error, error],
    },
    {
      code: 'const fs = require("node:fs"); fs.readFileSync(path);',
      errors: [error],
    },
    { code: 'require("fs").readdirSync(path);', errors: [error] },
    {
      code: 'import fs from "node:fs"; const { readFileSync: read } = fs;',
      errors: [error],
    },
  ],
});
