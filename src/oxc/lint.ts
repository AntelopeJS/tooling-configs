import { defineConfig } from "oxlint";

import { findGitRoot, MEASURE_ENV } from "../guardrails/ceilings.ts";
import { readCarriedCeilings } from "../guardrails/renames.ts";
import { TEST_FILE_GLOBS } from "./guardrails/shared.ts";
import { AGENT_IGNORE_PATTERNS, IGNORE_PATTERNS } from "./shared.ts";

export {
  ASSERTION_FUNCTION_NAMES,
  TEST_FILE_GLOBS,
} from "./guardrails/shared.ts";

/**
 * oxlint replaces rather than merges ignorePatterns across extends.
 * Spread these patterns when adding repository-specific ignores.
 */
export const ANTELOPE_IGNORE_PATTERNS = [
  ...IGNORE_PATTERNS,
  ...AGENT_IGNORE_PATTERNS,
];

type Severity = "off" | "error";

/** Thresholds allow request contexts and dependencies while rejecting outlier signatures and files. */
export interface ComplexityThresholds {
  maxParams: number;
  maxLinesPerFunction: number;
  maxLines: number;
  maxDepth: number;
  complexity: number;
}

export const DEFAULT_COMPLEXITY_THRESHOLDS: ComplexityThresholds = {
  maxParams: 5,
  maxLinesPerFunction: 120,
  maxLines: 500,
  maxDepth: 4,
  complexity: 20,
};

export interface AntelopePresetOptions {
  /** All fifteen vendored anti-slop rules. Defaults to true. */
  antiSlop?: boolean;
  /** Comment and test-quality rules. Defaults to true. */
  guardrails?: boolean;
  /** Complexity limits at error. Pass an object to override thresholds, or false to disable. */
  complexity?: boolean | Partial<ComplexityThresholds>;
  /**
   * Import sorting through eslint-plugin-perfectionist, autofixed by oxlint --fix.
   * Off by default because sorting value imports across side-effect imports
   * changes module registration order and breaks AntelopeJS packages at require time.
   * sortSideEffects: false keeps side-effect imports in place but lets values cross them.
   * perfectionist 5.11 refuses partitionByNewLine with newlinesBetween or newlinesInside.
   * Enable only when no import can cross a side-effect import, and install the optional
   * eslint-plugin-perfectionist peer dependency alongside this package.
   */
  importSorting?: boolean;
  /** Import cycles fail at runtime. Defaults to true. */
  importCycles?: boolean;
  /**
   * Type-aware rules. Defaults to true. Consumers must also set options.typeAware
   * in their root config because oxlint never reads that field from extends.
   */
  typeAware?: boolean;
}

/** Every vendored anti-slop rule, also used to lint this package from source. */
export const ANTI_SLOP_RULES = [
  "no-chained-type-assertions",
  "no-conditional-empty-object-spread",
  "no-known-value-widening",
  "no-module-mocking",
  "no-object-parameters",
  "no-reflect-apply",
  "no-reflect-get",
  "no-runtime-typeof",
  "no-shape-in-symbol-names",
  "no-unknown-parameters",
  "no-unknown-returns",
  "no-unknown-type-aliases",
  "no-unsafe-dictionary-type",
  "no-widen-then-assert",
  "require-safety-comment-for-type-assertion",
] as const;

/** Correctness must fail CI; underscore bindings and omitted rest siblings are intentional; `@ts-ignore` is banned because `@ts-expect-error` fails once the error is gone. */
function basePreset(importCycles: boolean) {
  return defineConfig({
    categories: { correctness: "error" },
    ignorePatterns: ANTELOPE_IGNORE_PATTERNS,
    plugins: ["eslint", "typescript", "node", "oxc", "import", "promise"],
    rules: {
      "eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],
      "eslint/eqeqeq": ["error", "always", { null: "ignore" }],
      "eslint/radix": "error",
      "eslint/prefer-regex-literals": "error",
      "import/no-cycle": importCycles ? "error" : "off",
      "import/no-self-import": "error",
      "import/no-duplicates": "error",
      "typescript/ban-ts-comment": [
        "error",
        {
          "ts-check": false,
          "ts-expect-error": false,
          "ts-ignore": true,
          "ts-nocheck": false,
        },
      ],
    },
  });
}

/**
 * All vendored rules at one severity, without resolving the published plugin.
 * `no-runtime-typeof` accepts a `typeof` whose nearest function returns a type
 * predicate or an assertion: that function is the decoder the rule asks for.
 */
export function antiSlopRules(severity: Severity = "error") {
  return Object.fromEntries(
    ANTI_SLOP_RULES.map((rule) => [
      `anti-slop/${rule}`,
      rule === "no-runtime-typeof"
        ? ([severity, { allowInTypeGuards: true }] satisfies [
            Severity,
            { allowInTypeGuards: boolean },
          ])
        : severity,
    ]),
  );
}

function antiSlopPreset() {
  return defineConfig({
    jsPlugins: [
      {
        name: "anti-slop",
        specifier: "@antelopejs/tooling-configs/oxc/anti-slop",
      },
    ],
    rules: antiSlopRules(),
  });
}

/** Jest matcher semantics and module restrictions are not portable to Mocha, Chai, and Vitest. */
export const FRAMEWORK_SPECIFIC_JEST_RULES = {
  "jest/no-conditional-expect": "off",
  "jest/no-export": "off",
  "jest/no-standalone-expect": "off",
  "jest/prefer-snapshot-hint": "off",
  "jest/require-to-throw-message": "off",
  "jest/valid-expect": "off",
  "jest/valid-expect-in-promise": "off",
} as const;

/** Source and published registration share test overrides without Jest framework detection. */
export function guardrailsRules() {
  return defineConfig({
    plugins: ["jest"],
    rules: {
      ...FRAMEWORK_SPECIFIC_JEST_RULES,
      "jest/expect-expect": "off",
      "antelopejs/no-comments": "error",
    },
    overrides: [
      {
        files: TEST_FILE_GLOBS,
        rules: {
          "antelopejs/no-fs-read-in-tests": "error",
          "antelopejs/no-constant-value-assertion": "error",
          "antelopejs/no-self-import-in-tests": "error",
          "antelopejs/no-typeof-function-only-test": "error",
          "antelopejs/require-assertion": "error",
        },
      },
      {
        files: ["**/fixtures/**", "**/helpers/**", "**/locales/**"],
        rules: {
          "antelopejs/no-fs-read-in-tests": "off",
        },
      },
    ],
  });
}

function guardrailsPreset() {
  return defineConfig({
    extends: [guardrailsRules()],
    jsPlugins: [
      {
        name: "antelopejs",
        specifier: "@antelopejs/tooling-configs/oxc/guardrails",
      },
    ],
  });
}

function complexityPreset(thresholds: ComplexityThresholds) {
  return defineConfig({
    rules: {
      "eslint/max-params": ["error", { max: thresholds.maxParams }],
      "eslint/max-lines-per-function": [
        "error",
        {
          max: thresholds.maxLinesPerFunction,
          skipBlankLines: true,
          skipComments: true,
        },
      ],
      "eslint/max-lines": [
        "error",
        { max: thresholds.maxLines, skipBlankLines: true, skipComments: true },
      ],
      "eslint/max-depth": ["error", { max: thresholds.maxDepth }],
      "eslint/complexity": ["error", { max: thresholds.complexity }],
    },
  });
}

/**
 * Besides the base set, five rules reject an `any` or a type parameter that
 * stands in for `unknown`, which the anti-slop `unknown` and assertion rules
 * never see: a once-used type parameter, `any` passed as a typed argument,
 * assigned to a typed binding or returned as a typed result, and an untyped
 * `.catch` callback variable.
 */
function typeAwarePreset() {
  return defineConfig({
    rules: {
      "typescript/no-unnecessary-type-parameters": "error",
      "typescript/no-unsafe-argument": "error",
      "typescript/no-unsafe-assignment": "error",
      "typescript/no-unsafe-return": "error",
      "typescript/use-unknown-in-catch-callback-variable": "error",
      "typescript/no-floating-promises": "error",
      "typescript/await-thenable": "error",
      "typescript/unbound-method": "error",
      "typescript/no-meaningless-void-operator": "error",
      "typescript/no-misused-spread": "error",
      "typescript/no-base-to-string": "error",
      "typescript/no-redundant-type-constituents": "error",
      "typescript/restrict-template-expressions": "error",
      "typescript/require-array-sort-compare": "error",
    },
  });
}

/** Side-effect imports register classes, so sorting may never relocate them. */
function importSortingPreset() {
  return defineConfig({
    jsPlugins: ["eslint-plugin-perfectionist"],
    rules: {
      "perfectionist/sort-imports": [
        "error",
        {
          type: "line-length",
          order: "asc",
          sortSideEffects: false,
          internalPattern: ["^@/.*", "^~/.*"],
          groups: [
            ["builtin", "external"],
            [
              "internal",
              "subpath",
              "parent",
              "sibling",
              "index",
              "style",
              "unknown",
            ],
          ],
        },
      ],
    },
  });
}

/** Overrides run after rules, including test-specific rules; measurement bypasses all ceilings. */
function ratchetOverrides() {
  if (process.env[MEASURE_ENV] !== undefined) return [];
  const ceilings = readCarriedCeilings(findGitRoot());
  const rules: Record<string, "off"> = Object.fromEntries(
    Object.keys(ceilings.rules).map((rule) => [rule, "off"]),
  );
  return [
    ...Object.keys(ceilings.oversizeFiles).map((path) => ({
      files: [path.replaceAll(/([*?[\]{}])/gu, "\\$1")],
      rules: { "eslint/max-lines": "off" as const },
    })),
    { files: ["**/*"], rules },
  ];
}

/** The shared AntelopeJS preset. Every enabled rule fails CI; recorded debt is enforced by the ratchet. */
export function antelopePreset(options: AntelopePresetOptions = {}) {
  let thresholds = DEFAULT_COMPLEXITY_THRESHOLDS;
  if (
    options.complexity !== true &&
    options.complexity !== false &&
    options.complexity !== undefined
  ) {
    thresholds = { ...thresholds, ...options.complexity };
  }
  return defineConfig({
    extends: [
      basePreset(options.importCycles !== false),
      options.typeAware === false ? null : typeAwarePreset(),
      options.antiSlop === false ? null : antiSlopPreset(),
      options.guardrails === false ? null : guardrailsPreset(),
      options.complexity === false ? null : complexityPreset(thresholds),
      options.importSorting === true ? importSortingPreset() : null,
    ].filter((config) => config !== null),
    rules: {
      "typescript/no-floating-promises":
        options.typeAware === false ? "off" : "error",
    },
    overrides: ratchetOverrides(),
  });
}
