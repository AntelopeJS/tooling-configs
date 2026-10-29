import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

import { syncRepository } from "./sync.ts";
import { countSuppressions, suppressionsIn } from "./suppressions.ts";
import { bin, commit, put, read, testRepo } from "./helpers/test-repo.ts";

const CLOUD_TEST_RULES = [
  'import { defineConfig } from "oxlint";',
  'import { ANTELOPE_IGNORE_PATTERNS, antelopePreset } from "@antelopejs/tooling-configs/oxc/lint";',
  "",
  'const OWN_TOOLCHAIN_PATTERNS = ["cli/**", ".dms-frontend/**"];',
  "",
  "const TEST_RULES = {",
  '  "eslint/complexity": "off",',
  '  "eslint/max-depth": "off",',
  '  "eslint/max-lines": "off",',
  '  "eslint/max-lines-per-function": "off",',
  '  "typescript/unbound-method": "off",',
  '  "typescript/no-misused-spread": "off",',
  '  "anti-slop/no-chained-type-assertions": "off",',
  '  "anti-slop/no-conditional-empty-object-spread": "off",',
  '  "eslint/no-unused-expressions": "off",',
  "} as const;",
  "",
  "export default defineConfig({",
  "  extends: [antelopePreset({ importSorting: false })],",
  "  ignorePatterns: [...ANTELOPE_IGNORE_PATTERNS, ...OWN_TOOLCHAIN_PATTERNS],",
  "  options: { typeAware: true, maxWarnings: 0 },",
  "  overrides: [{ files: [__FILES__], rules: TEST_RULES }],",
  "});",
  "",
].join("\n");

const cloudConfig = (files: string[]) =>
  CLOUD_TEST_RULES.replace(
    "__FILES__",
    files.map((glob) => JSON.stringify(glob)).join(", "),
  );

const CLOUD_RULES = [
  "anti-slop/no-chained-type-assertions",
  "anti-slop/no-conditional-empty-object-spread",
  "eslint/complexity",
  "eslint/max-depth",
  "eslint/max-lines",
  "eslint/max-lines-per-function",
  "eslint/no-unused-expressions",
  "typescript/no-misused-spread",
  "typescript/unbound-method",
];

const WEB_SHOWCASE_OVERRIDE = [
  "  {",
  '    files: ["**/components/SettingsShowcase.vue", "**/components/settings-showcase/**"],',
  "    rules: {",
  '      "@intlify/vue-i18n/no-raw-text": "off",',
  "    },",
  "  },",
];

const webEslintConfig = (showcase: boolean) =>
  [
    'import vueI18n from "@intlify/eslint-plugin-vue-i18n";',
    'import withNuxt from "./sites/framework/.nuxt/eslint.config.mjs";',
    "",
    "export default withNuxt(",
    "  {",
    "    rules: {",
    '      "vue/no-v-html": "off",',
    "    },",
    "  },",
    '  ...vueI18n.configs["flat/recommended"],',
    "  {",
    "    rules: {",
    '      "@intlify/vue-i18n/no-raw-text": ["error", { ignorePattern: "^[\\\\s\\\\d]+$" }],',
    '      "@intlify/vue-i18n/no-unused-keys": "off",',
    "    },",
    "  },",
    ...(showcase ? WEB_SHOWCASE_OVERRIDE : []),
    "  {",
    '    files: ["**/components/OgImage/**"],',
    "    rules: {",
    '      "@intlify/vue-i18n/no-raw-text": "off",',
    "    },",
    "  },",
    ");",
    "",
  ].join("\n");

const LEGACY_BUDGET = `${JSON.stringify(
  { rules: {}, tsExpectError: 0, tsIgnore: 0, safety: 0 },
  null,
  2,
)}\n`;

function git(root: string, args: string[]): void {
  execFileSync("git", args, { cwd: root });
}

function head(root: string): string {
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
}

function adoptedRepo(
  t: Parameters<typeof testRepo>[0],
  files: Record<string, string>,
): string {
  const root = testRepo(t);
  for (const [path, content] of Object.entries(files)) put(root, path, content);
  put(root, "guardrails.suppressions.json", LEGACY_BUDGET);
  put(
    root,
    "package.json",
    '{\n  "name": "budget", "scripts": { "sync:check": "x" }\n}\n',
  );
  syncRepository(root);
  commit(root);
  return root;
}

function budgetRepo(
  t: Parameters<typeof testRepo>[0],
  files: Record<string, string>,
  config: Record<string, number>,
): string {
  const root = testRepo(t);
  for (const [path, content] of Object.entries(files)) put(root, path, content);
  put(
    root,
    "guardrails.suppressions.json",
    `${JSON.stringify({ ...JSON.parse(LEGACY_BUDGET), config }, null, 2)}\n`,
  );
  commit(root);
  return root;
}

const CONFIG_FIX =
  /Fix: delete the config entry and fix the code its rule reports, or move the exception onto the line that needs it as a directive with a reason\./;

test("cloud #379: widening an override that switches rules off to scripts/test-*.cjs fails the budget, staged and full", (t) => {
  const root = budgetRepo(
    t,
    { "oxlint.config.ts": cloudConfig(["src/test/**"]) },
    Object.fromEntries(
      CLOUD_RULES.map((rule) => [`${rule} for src/test/**`, 1]),
    ),
  );
  assert.equal(bin(root, "suppressions").status, 0);
  put(
    root,
    "oxlint.config.ts",
    cloudConfig(["src/test/**", "scripts/test-*.cjs"]),
  );
  const full = bin(root, "suppressions");
  assert.equal(full.status, 1);
  assert.match(
    full.stderr,
    /lint config rule-off `typescript\/unbound-method` for `scripts\/test-\*\.cjs`: 1 exceeds ceiling 0\.\n {2}oxlint\.config\.ts:11\n/,
  );
  assert.match(full.stderr, CONFIG_FIX);
  git(root, ["add", "oxlint.config.ts"]);
  const staged = bin(root, "suppressions", ["--staged"]);
  assert.equal(staged.status, 1);
  assert.match(
    staged.stderr,
    /lint config rule-off `typescript\/unbound-method` for `scripts\/test-\*\.cjs`: this commit adds 1 to the staged files\.\n {2}oxlint\.config\.ts:11\n(?! {2})/,
  );
  git(root, ["reset", "-q", "--hard"]);
  put(root, "src/test/drivers.test.ts", "export const driver = 1;\n");
  git(root, ["add", "."]);
  assert.equal(bin(root, "suppressions", ["--staged"]).status, 0);
});

test("antelope-web #47: an ESLint override switching no-raw-text off for the split SettingsShowcase fails the budget", (t) => {
  const root = budgetRepo(
    t,
    { "eslint.config.mjs": webEslintConfig(false) },
    {
      "@intlify/vue-i18n/no-raw-text for **/components/OgImage/**": 1,
      "@intlify/vue-i18n/no-unused-keys for *": 1,
      "vue/no-v-html for *": 1,
    },
  );
  assert.equal(bin(root, "suppressions").status, 0);
  put(root, "eslint.config.mjs", webEslintConfig(true));
  const full = bin(root, "suppressions");
  assert.equal(full.status, 1);
  assert.match(
    full.stderr,
    /lint config rule-off `@intlify\/vue-i18n\/no-raw-text` for `\*\*\/components\/SettingsShowcase\.vue`: 1 exceeds ceiling 0\.\n {2}eslint\.config\.mjs:20\n/,
  );
  assert.match(full.stderr, CONFIG_FIX);
});

test("a config that only extends the preset, enables rules, sets options or tunes a rule at error counts nothing", () => {
  const own = [
    'import { defineConfig } from "oxlint";',
    'import { antelopePreset, antiSlopRules, guardrailsRules } from "./src/oxc/lint.ts";',
    "",
    '/** Mentions "no-console": "off" in prose only. */',
    "export default defineConfig({",
    "  extends: [guardrailsRules(), antelopePreset({ antiSlop: false })],",
    '  ignorePatterns: ["src/oxc/anti-slop/**"],',
    "  options: { typeAware: false, maxWarnings: 0 },",
    '  settings: { mode: "off" },',
    '  rules: { ...antiSlopRules(), "eslint/no-console": "error", "eslint/max-params": ["error", { max: 4 }] },',
    '  overrides: [{ files: ["src/**"], rules: { "eslint/no-debugger": 2 } }],',
    "});",
    "",
  ].join("\n");
  assert.deepEqual(
    countSuppressions(suppressionsIn("oxlint.config.ts", own)).config,
    {},
  );
  assert.deepEqual(
    countSuppressions(
      suppressionsIn(
        "src/rules.ts",
        'export const rules = { "eslint/no-console": "off" };\n',
      ),
    ).config,
    {},
  );
});

test("an .oxlintrc.json with comments counts each rule off, warn or allow and each category switched off, once per override glob", () => {
  const legacy = [
    "{",
    "  // the preset is extended through the root config",
    '  "categories": { "correctness": "off", "suspicious": "error" },',
    '  "rules": { "eslint/no-console": "warn", "eslint/no-debugger": ["allow"], "eslint/eqeqeq": 0 },',
    '  "overrides": [{ "files": ["a/**", "b/**"], "rules": { "typescript/unbound-method": "off" } }]',
    "}",
    "",
  ].join("\n");
  assert.deepEqual(
    countSuppressions(suppressionsIn("packages/web/.oxlintrc.json", legacy))
      .config,
    {
      "category:correctness for *": 1,
      "eslint/eqeqeq for *": 1,
      "eslint/no-console for *": 1,
      "eslint/no-debugger for *": 1,
      "typescript/unbound-method for a/**": 1,
      "typescript/unbound-method for b/**": 1,
    },
  );
});

test("the full check fails a raised config ceiling against the base, and --update lowers it", (t) => {
  const root = adoptedRepo(t, {
    "oxlint.config.ts": cloudConfig(["src/test/**", "scripts/test-*.cjs"]),
  });
  put(root, "oxlint.config.ts", cloudConfig(["src/test/**"]));
  assert.equal(bin(root, "suppressions", ["--update"]).status, 0);
  const lowered = JSON.parse(read(root, "guardrails.suppressions.json")).config;
  assert.equal(lowered?.["typescript/unbound-method for src/test/**"], 1);
  assert.equal(
    lowered?.["typescript/unbound-method for scripts/test-*.cjs"],
    0,
  );
  commit(root);
  put(
    root,
    "guardrails.suppressions.json",
    read(root, "guardrails.suppressions.json").replace(
      '"typescript/unbound-method for src/test/**": 1',
      '"typescript/unbound-method for src/test/**": 3',
    ),
  );
  const raised = bin(root, "suppressions", ["--base", "HEAD"]);
  assert.equal(raised.status, 1);
  assert.match(
    raised.stderr,
    /raises lint config rule-off `typescript\/unbound-method for src\/test\/\*\*` from 1 on the base to 3\./,
  );
});

test("sync adopts the config rule-offs into an existing budget at today's counts, so upgrading fails nothing", (t) => {
  const root = adoptedRepo(t, {
    "oxlint.config.ts": cloudConfig(["src/test/**"]),
    "eslint.config.mjs": webEslintConfig(true),
  });
  assert.deepEqual(
    JSON.parse(read(root, "guardrails.suppressions.json")).config,
    {
      ...Object.fromEntries(
        CLOUD_RULES.map((rule) => [`${rule} for src/test/**`, 1]),
      ),
      "@intlify/vue-i18n/no-raw-text for **/components/OgImage/**": 1,
      "@intlify/vue-i18n/no-raw-text for **/components/SettingsShowcase.vue": 1,
      "@intlify/vue-i18n/no-raw-text for **/components/settings-showcase/**": 1,
      "@intlify/vue-i18n/no-unused-keys for *": 1,
      "vue/no-v-html for *": 1,
    },
  );
  const check = bin(root, "suppressions");
  assert.equal(check.status, 0, check.stderr);
  assert.equal(syncRepository(root, { check: true }).paths.length, 0);
});

test("an ESLint composer's overrideRules counts like a rules block, and a config entry switching off a never-suppressed rule fails even under a raised ceiling", (t) => {
  assert.deepEqual(
    countSuppressions(
      suppressionsIn(
        "eslint.config.mjs",
        'export default withNuxt().overrideRules({ "vue/no-v-html": "off", "vue/require-default-prop": "error" });\n',
      ),
    ).config,
    { "vue/no-v-html for *": 1 },
  );
  const root = budgetRepo(
    t,
    { "oxlint.config.ts": cloudConfig(["src/test/**"]) },
    {
      ...Object.fromEntries(
        CLOUD_RULES.map((rule) => [`${rule} for src/test/**`, 1]),
      ),
      "antelopejs/require-assertion for src/test/**": 1,
    },
  );
  put(
    root,
    "oxlint.config.ts",
    cloudConfig(["src/test/**"]).replace(
      '"eslint/complexity": "off",',
      '"eslint/complexity": "off",\n  "antelopejs/require-assertion": "off",',
    ),
  );
  const check = bin(root, "suppressions");
  assert.equal(check.status, 1);
  assert.match(
    check.stderr,
    /oxlint\.config\.ts:8: lint config rule-off `antelopejs\/require-assertion` for `src\/test\/\*\*`: this rule is never suppressed\. Fix: assert on the behaviour, or delete the test\./,
  );
});

const SCOPE_MOVES: [string, string, string][] = [
  [
    "widening src/test/** to src/** in place",
    "src/**",
    cloudConfig(["src/**"]),
  ],
  ["widening src/test/** to **/* in place", "**/*", cloudConfig(["**/*"])],
  [
    "deleting the override's files",
    "*",
    CLOUD_TEST_RULES.replace("files: [__FILES__], ", ""),
  ],
  [
    "moving the override's rules to the top level",
    "*",
    CLOUD_TEST_RULES.replace(
      "  overrides: [{ files: [__FILES__], rules: TEST_RULES }],",
      "  rules: TEST_RULES,",
    ),
  ],
];

for (const [move, scope, config] of SCOPE_MOVES)
  test(`cloud #379 r3: ${move} switches the rules off for a new scope and fails, staged and full`, (t) => {
    const root = adoptedRepo(t, {
      "oxlint.config.ts": cloudConfig(["src/test/**"]),
    });
    put(root, "oxlint.config.ts", config);
    const label = new RegExp(
      `lint config rule-off \`typescript/unbound-method\` for \`${scope.replaceAll("*", "\\*")}\``,
    );
    const full = bin(root, "suppressions");
    assert.equal(full.status, 1);
    assert.match(full.stderr, label);
    git(root, ["add", "oxlint.config.ts"]);
    const staged = bin(root, "suppressions", ["--staged"]);
    assert.equal(staged.status, 1);
    assert.match(staged.stderr, label);
    const adopted = head(root);
    bin(root, "suppressions", ["--update"]);
    commit(root);
    assert.equal(bin(root, "suppressions", ["--base", adopted]).status, 1);
  });

const NARROWINGS: [string, string[]][] = [
  ["narrowing src/test/** to src/test/unit/** in place", ["src/test/unit/**"]],
  [
    "splitting src/test/** into src/test/unit/** and src/test/e2e/**",
    ["src/test/unit/**", "src/test/e2e/**"],
  ],
];

for (const [narrowing, globs] of NARROWINGS)
  test(`${narrowing} is burn-down: staged, full, --update and --base pass, and --update moves the ceiling to the narrower keys`, (t) => {
    const root = adoptedRepo(t, {
      "oxlint.config.ts": cloudConfig(["src/test/**"]),
    });
    const adopted = head(root);
    put(root, "oxlint.config.ts", cloudConfig(globs));
    git(root, ["add", "oxlint.config.ts"]);
    const staged = bin(root, "suppressions", ["--staged"]);
    assert.equal(staged.status, 0, staged.stderr);
    const full = bin(root, "suppressions");
    assert.equal(full.status, 0, full.stderr);
    const update = bin(root, "suppressions", ["--update"]);
    assert.equal(update.status, 0, update.stderr);
    const config = JSON.parse(
      read(root, "guardrails.suppressions.json"),
    ).config;
    assert.equal(config["typescript/unbound-method for src/test/**"], 0);
    for (const glob of globs)
      assert.equal(config[`typescript/unbound-method for ${glob}`], 1);
    commit(root);
    assert.equal(bin(root, "suppressions").status, 0);
    const base = bin(root, "suppressions", ["--base", adopted]);
    assert.equal(base.status, 0, base.stderr);
  });

test("widening by renaming src/test/** to src/** in the config and the budget still fails against the base", (t) => {
  const root = adoptedRepo(t, {
    "oxlint.config.ts": cloudConfig(["src/test/**"]),
  });
  const adopted = head(root);
  put(root, "oxlint.config.ts", cloudConfig(["src/**"]));
  put(
    root,
    "guardrails.suppressions.json",
    read(root, "guardrails.suppressions.json").replaceAll(
      " for src/test/**",
      " for src/**",
    ),
  );
  commit(root);
  assert.equal(bin(root, "suppressions").status, 0);
  const base = bin(root, "suppressions", ["--base", adopted]);
  assert.equal(base.status, 1);
  assert.match(
    base.stderr,
    /raises lint config rule-off `typescript\/unbound-method for src\/\*\*` from 0 on the base to 1\./,
  );
});
