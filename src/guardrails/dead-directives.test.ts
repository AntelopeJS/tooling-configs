import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, symlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";

import { formatCeilings } from "./ceilings.ts";
import { formatBudget } from "./suppression-budget.ts";
import {
  bin,
  commit,
  linkOxlint,
  put,
  testRepo,
  usePreset,
} from "./helpers/test-repo.ts";

const CDN_REQUEST = (timeout: string) =>
  [
    "export async function request(url: string): Promise<string> {",
    "  // eslint-disable-next-line @typescript-eslint/no-implied-eval",
    '  const dynamicImport = new Function("specifier", "return import(specifier)");',
    "  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access",
    '  const fetch = (await dynamicImport("node-fetch")).default;',
    `  const timeoutMs = ${timeout};`,
    "  return String(await fetch(url, { timeoutMs }));",
    "}",
    "",
  ].join("\n");

const CDN_REASON =
  "with `module: commonjs` tsc rewrites a literal `import()` into `require()`, and `node-fetch` 3 is ESM-only, which `require()` cannot load on Node versions without `require(esm)`";

const CDN_FIXED = (timeout: string) =>
  [
    "export async function request(url: string): Promise<string> {",
    `  // eslint-disable-next-line @typescript-eslint/no-implied-eval -- ${CDN_REASON}`,
    '  const dynamicImport = new Function("specifier", "return import(specifier)");',
    '  const fetch = (await dynamicImport("node-fetch")).default;',
    `  const timeoutMs = ${timeout};`,
    "  return String(await fetch(url, { timeoutMs }));",
    "}",
    "",
  ].join("\n");

const PAYMENT_SUPPORT = (teardown: string) =>
  [
    "declare function after(...args: unknown[]): void;",
    "declare function stop(): void;",
    "",
    teardown,
    "",
    "interface ProviderControl {",
    "  ledger(): string[];",
    "}",
    "",
    "// oxlint-disable-next-line typescript/no-require-imports -- the provider is plain CommonJS outside src",
    "export const provider: ProviderControl =",
    '  require("../../test/payment-provider").testControl;',
    "",
  ].join("\n");

const PAYMENT_TEARDOWN_BEFORE = "after(() => stop());";

const PAYMENT_TEARDOWN_AFTER = [
  "after(",
  '  "quiesce renewals before the runner tears down the database provider",',
  "  () => stop(),",
  ");",
].join("\n");

const DICTIONARY = (name: string) =>
  [
    "// oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- the CDN reply carries arbitrary per-file metadata keys chosen by the uploader",
    `export const ${name}: Record<string, unknown> = {};`,
    "",
  ].join("\n");

function linkTypeAware(root: string): void {
  linkOxlint(root);
  const require = createRequire(import.meta.url);
  const tsgolint = join(
    dirname(require.resolve("oxlint-tsgolint/package.json")),
    "bin/tsgolint.js",
  );
  mkdirSync(join(root, "node_modules/.bin"), { recursive: true });
  symlinkSync(tsgolint, join(root, "node_modules/.bin/tsgolint"));
}

/** A consumer on the shared preset, type-aware, with plugin specifiers redirected to the unbuilt source. */
function presetRepo(
  t: TestContext,
  files: Record<string, string>,
  rules: Record<string, number>,
  ratchet: Record<string, number> = {},
): string {
  const root = testRepo(t);
  linkTypeAware(root);
  usePreset(root, true);
  put(
    root,
    "tsconfig.json",
    JSON.stringify({
      compilerOptions: {
        strict: true,
        module: "nodenext",
        target: "es2022",
        noEmit: true,
        types: [],
      },
      include: ["**/*.ts"],
    }),
  );
  if (Object.keys(ratchet).length)
    put(
      root,
      "guardrails.ratchet.json",
      formatCeilings({ rules: ratchet, oversizeFiles: {} }),
    );
  put(
    root,
    "guardrails.suppressions.json",
    formatBudget({ rules, tsExpectError: 0, tsIgnore: 0, safety: 0 }),
  );
  for (const [path, content] of Object.entries(files)) put(root, path, content);
  commit(root);
  return root;
}

function head(root: string): string {
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
}

function stage(root: string): void {
  execFileSync("git", ["add", "-A"], { cwd: root });
}

/** The full check against `base` after committing the change, and the staged check before committing it. */
function bothModes(root: string, change: () => void) {
  const base = head(root);
  change();
  stage(root);
  const staged = bin(root, "suppressions", ["--staged"]);
  commit(root);
  const full = bin(root, "suppressions", ["--base", base]);
  return { staged, full };
}

const CDN_BUDGET = {
  "@typescript-eslint/no-implied-eval": 1,
  "@typescript-eslint/no-unsafe-member-access": 1,
};

test("cdn#19: touching src/index.ts fails its dead no-unsafe-member-access directive and its reasonless no-implied-eval one, in both modes", (t) => {
  const root = presetRepo(
    t,
    { "src/index.ts": CDN_REQUEST("timeout ?? 1000") },
    CDN_BUDGET,
  );
  const { staged, full } = bothModes(root, () =>
    put(root, "src/index.ts", CDN_REQUEST("timeout ?? 30_000")),
  );
  for (const result of [staged, full]) {
    assert.equal(result.status, 1, result.stderr);
    assert.match(
      result.stderr,
      /src\/index\.ts:4: `eslint-disable-next-line @typescript-eslint\/no-unsafe-member-access` suppresses nothing.*Fix: delete the directive/u,
    );
    assert.match(
      result.stderr,
      /src\/index\.ts:2: `eslint-disable-next-line @typescript-eslint\/no-implied-eval` gives no reason.*Fix: /u,
    );
    assert.doesNotMatch(
      result.stderr,
      /src\/index\.ts:2: .*suppresses nothing/u,
    );
  }
});

test("cdn#19 fixed: the live no-implied-eval directive with its reason passes, and deleting the dead one needs no raise", (t) => {
  const root = presetRepo(
    t,
    { "src/index.ts": CDN_REQUEST("timeout ?? 1000") },
    CDN_BUDGET,
  );
  const { staged, full } = bothModes(root, () =>
    put(root, "src/index.ts", CDN_FIXED("timeout ?? 30_000")),
  );
  assert.equal(staged.status, 0, staged.stderr);
  assert.equal(full.status, 0, full.stderr);
});

test("payment-subscriptions#13: touching src/test/support.ts fails its dead directive for typescript/no-require-imports, a rule the preset does not enable", (t) => {
  const root = presetRepo(
    t,
    { "src/test/support.ts": PAYMENT_SUPPORT(PAYMENT_TEARDOWN_BEFORE) },
    { "typescript/no-require-imports": 1 },
  );
  const { staged, full } = bothModes(root, () =>
    put(root, "src/test/support.ts", PAYMENT_SUPPORT(PAYMENT_TEARDOWN_AFTER)),
  );
  for (const result of [staged, full]) {
    assert.equal(result.status, 1, result.stderr);
    assert.match(
      result.stderr,
      /src\/test\/support\.ts:13: `oxlint-disable-next-line typescript\/no-require-imports` suppresses nothing.*Fix: delete the directive/u,
    );
  }
});

test("a dead directive in a file the change does not touch is left to the burn-down, as on a pack upgrade", (t) => {
  const root = presetRepo(
    t,
    {
      "src/index.ts": CDN_REQUEST("timeout ?? 1000"),
      "src/test/support.ts": PAYMENT_SUPPORT(PAYMENT_TEARDOWN_BEFORE),
    },
    { ...CDN_BUDGET, "typescript/no-require-imports": 1 },
  );
  const { staged, full } = bothModes(root, () =>
    put(root, "src/other.ts", "export const other = 1;\n"),
  );
  assert.equal(staged.status, 0, staged.stderr);
  assert.equal(full.status, 0, full.stderr);
});

test("a directive for a ratcheted rule that still suppresses a finding passes in a touched file", (t) => {
  const root = presetRepo(
    t,
    { "src/meta.ts": DICTIONARY("meta") },
    { "anti-slop/no-unsafe-dictionary-type": 1 },
    { "anti-slop/no-unsafe-dictionary-type": 1 },
  );
  const { staged, full } = bothModes(root, () =>
    put(root, "src/meta.ts", `${DICTIONARY("meta")}export const count = 1;\n`),
  );
  assert.equal(staged.status, 0, staged.stderr);
  assert.equal(full.status, 0, full.stderr);
});

const TRACE = (result: number) =>
  [
    "export function trace(): number {",
    "  // oxlint-disable-next-line eslint/no-debugger, eslint/no-console -- the debugger statement pauses the trace probe here",
    "  debugger;",
    "  /* oxlint-disable eslint/no-debugger, eslint/no-console -- the probe below pauses twice for the trace harness */",
    "  debugger;",
    "  /* oxlint-enable eslint/no-debugger, eslint/no-console */",
    `  return ${result};`,
    "}",
    "",
  ].join("\n");

test("a dead rule in a block disable and in a directive naming two rules fails at the directive, naming the rule to drop", (t) => {
  const root = presetRepo(
    t,
    { "src/debug.ts": TRACE(1) },
    {
      "eslint/no-console": 2,
      "eslint/no-debugger": 2,
    },
  );
  const { staged, full } = bothModes(root, () =>
    put(root, "src/debug.ts", TRACE(2)),
  );
  for (const result of [staged, full]) {
    assert.equal(result.status, 1, result.stderr);
    assert.match(
      result.stderr,
      /src\/debug\.ts:2: `oxlint-disable-next-line eslint\/no-console` suppresses nothing.*Fix: drop `eslint\/no-console` from the directive/u,
    );
    assert.match(
      result.stderr,
      /src\/debug\.ts:4: `oxlint-disable eslint\/no-console` suppresses nothing/u,
    );
    assert.doesNotMatch(result.stderr, /no-debugger` suppresses nothing/u);
  }
});

const HTML = (value: number) =>
  `// eslint-disable-next-line vue/no-v-html -- the markup comes from the sanitized CMS renderer\nexport const html = ${value};\n`;

test("an eslint-disable directive under an ESLint config is left to ESLint, which may run the rule", (t) => {
  const root = presetRepo(
    t,
    {
      "frontend-vue/eslint.config.mjs": "export default [];\n",
      "frontend-vue/utils/html.ts": HTML(1),
    },
    { "vue/no-v-html": 1 },
  );
  const { staged, full } = bothModes(root, () =>
    put(root, "frontend-vue/utils/html.ts", HTML(2)),
  );
  assert.equal(staged.status, 0, staged.stderr);
  assert.equal(full.status, 0, full.stderr);
});
