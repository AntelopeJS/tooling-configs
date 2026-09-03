import { defineConfig } from "oxlint";

import { AGENT_IGNORE_PATTERNS, IGNORE_PATTERNS } from "./shared.ts";

/**
 * The paths the preset ignores. oxlint does not merge `ignorePatterns` across
 * `extends`: a root config that declares its own **replaces** these, so spread
 * them when a repository adds patterns of its own.
 *
 * @example
 * ```ts
 * export default defineConfig({
 *   extends: [antelopePreset()],
 *   ignorePatterns: [...ANTELOPE_IGNORE_PATTERNS, "playground/**"],
 * });
 * ```
 */
export const ANTELOPE_IGNORE_PATTERNS = [
  ...IGNORE_PATTERNS,
  ...AGENT_IGNORE_PATTERNS,
];

type Severity = "off" | "warn" | "error";

/**
 * Thresholds for the complexity rules. The defaults are deliberately looser than
 * oxlint's own (3 parameters, 50 lines per function): AntelopeJS handlers take a
 * request context plus its dependencies, and interface files declare long types.
 * They are meant to catch the outliers, not to redesign every signature.
 */
export interface ComplexityThresholds {
  /** `eslint/max-params` (oxlint default: 3). */
  maxParams: number;
  /** `eslint/max-lines-per-function` (oxlint default: 50). */
  maxLinesPerFunction: number;
  /** `eslint/max-lines` (oxlint default: 300). */
  maxLines: number;
  /** `eslint/max-depth` (oxlint default: 4). */
  maxDepth: number;
  /** `eslint/complexity`, cyclomatic (oxlint default: 20). */
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
  /**
   * Vendored anti-slop rules, which reject low-evidence TypeScript (`unknown`
   * parameters, unjustified `as` assertions, open dictionaries...).
   * `true` maps to `"warn"`: a repository adopting them has findings to work
   * through before the gate can be raised to `"error"`.
   *
   * @default "warn"
   */
  antiSlop?: boolean | Severity;
  /**
   * Complexity ceilings. Pass an object to override individual thresholds.
   *
   * @default "warn" with {@link DEFAULT_COMPLEXITY_THRESHOLDS}
   */
  complexity?:
    | boolean
    | (Partial<ComplexityThresholds> & { severity?: Severity });
  /**
   * Import sorting through `eslint-plugin-perfectionist`, autofixed by
   * `oxlint --fix`. Repositories that still let Biome organize imports must
   * leave this off until they drop that assist, or the two tools fight.
   *
   * The plugin is an optional peer dependency: it pulls ESLint and
   * typescript-eslint in with it, which a repository that turns this off has no
   * reason to install. Add `eslint-plugin-perfectionist` alongside this package
   * when leaving it on.
   *
   * @default true
   */
  importSorting?: boolean;
  /**
   * Severity of `import/no-cycle`. A cycle only shows up at runtime, in a
   * consumer's process, so it ships as an error — but a repository that already
   * has cycles needs to see them without a red pipeline while it untangles them.
   *
   * @default "error"
   */
  importCycles?: boolean | Severity;
  /**
   * `typescript/no-floating-promises`, which needs type information. The
   * consuming repository must also set `options.typeAware` in its own root
   * config: oxlint only reads that field there, never from an extended preset.
   *
   * @default true
   */
  typeAware?: boolean;
}

/** Every generic anti-slop rule, exported so this package can lint itself. */
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

/** Shared empty override set, so the threshold spread is never conditional. */
const EMPTY_THRESHOLDS: Partial<ComplexityThresholds> & {
  severity?: Severity;
} = {};

function severityOf(
  option: boolean | Severity | undefined,
  fallback: Severity,
): Severity {
  if (option === undefined || option === true) return fallback;
  if (option === false) return "off";
  return option;
}

function basePreset(cycleSeverity: Severity) {
  return defineConfig({
    // oxlint reports `correctness` as warnings, and warnings do not fail the
    // command. Left alone, nothing this preset finds could ever fail CI -- and
    // these are the rules that catch duplicate object keys and unused bindings,
    // which Biome was failing the build on before.
    categories: { correctness: "error" },
    ignorePatterns: ANTELOPE_IGNORE_PATTERNS,
    plugins: ["eslint", "typescript", "node", "oxc", "import", "promise"],
    rules: {
      // `_` marks a parameter kept for the signature's shape, which is the same
      // convention the Nuxt layers' ESLint config already encodes.
      "eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      // Biome's recommended set blocked these and oxlint's correctness category
      // does not, so dropping Biome quietly removed them. `== null` stays
      // allowed, as it was there: it is the idiomatic nullish check.
      "eslint/eqeqeq": ["error", "always", { null: "ignore" }],
      "eslint/radix": "error",
      "eslint/prefer-regex-literals": "error",
      "import/no-cycle": cycleSeverity,
      "import/no-self-import": "error",
      "import/no-duplicates": "error",
    },
  });
}

/**
 * The anti-slop rules at one severity. Exported for this repository's own config:
 * it registers the plugin from source rather than through the package exports,
 * so linting never waits on a build.
 */
export function antiSlopRules(severity: Severity): Record<string, Severity> {
  return Object.fromEntries(
    ANTI_SLOP_RULES.map((rule) => [`anti-slop/${rule}`, severity]),
  );
}

function antiSlopPreset(severity: Severity) {
  return defineConfig({
    jsPlugins: [
      {
        name: "anti-slop",
        specifier: "@antelopejs/tooling-configs/oxc/anti-slop",
      },
    ],
    rules: Object.fromEntries(
      ANTI_SLOP_RULES.map((rule) => [`anti-slop/${rule}`, severity]),
    ),
  });
}

function complexityPreset(
  thresholds: ComplexityThresholds,
  severity: Severity,
) {
  return defineConfig({
    rules: {
      "eslint/max-params": [severity, { max: thresholds.maxParams }],
      "eslint/max-lines-per-function": [
        severity,
        {
          max: thresholds.maxLinesPerFunction,
          skipBlankLines: true,
          skipComments: true,
        },
      ],
      "eslint/max-lines": [
        severity,
        { max: thresholds.maxLines, skipBlankLines: true, skipComments: true },
      ],
      "eslint/max-depth": [severity, { max: thresholds.maxDepth }],
      "eslint/complexity": [severity, { max: thresholds.complexity }],
    },
  });
}

/**
 * Turning on type information enables a whole family of rules, not just the one
 * worth the setup. `no-floating-promises` catches a promise whose rejection is
 * lost, which is why type-aware linting is worth running at all; the rest report
 * until a repository has worked through them, like every other backlog here.
 */
function typeAwarePreset() {
  return defineConfig({
    rules: {
      "typescript/no-floating-promises": "error",
      "typescript/await-thenable": "warn",
      "typescript/unbound-method": "warn",
      "typescript/no-meaningless-void-operator": "warn",
      "typescript/no-misused-spread": "warn",
      "typescript/no-base-to-string": "warn",
      "typescript/no-redundant-type-constituents": "warn",
      "typescript/restrict-template-expressions": "warn",
      "typescript/require-array-sort-compare": "warn",
    },
  });
}

function importSortingPreset() {
  return defineConfig({
    jsPlugins: ["eslint-plugin-perfectionist"],
    rules: {
      "perfectionist/sort-imports": [
        "error",
        {
          type: "line-length",
          order: "asc",
          internalPattern: ["^@/.*", "^~/.*"],
          groups: [
            ["side-effect", "side-effect-style"],
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

/**
 * The shared AntelopeJS oxlint preset: oxc's own defaults (the `correctness`
 * category), plus import hygiene, complexity ceilings, import sorting, and the
 * vendored anti-slop rules.
 *
 * @example
 * ```ts
 * // oxlint.config.ts
 * import { defineConfig } from "oxlint";
 * import { antelopePreset } from "@antelopejs/tooling-configs/oxc/lint";
 *
 * export default defineConfig({
 *   extends: [antelopePreset()],
 *   options: { typeAware: true },
 * });
 * ```
 */
export function antelopePreset(options: AntelopePresetOptions = {}) {
  const complexity = options.complexity ?? true;
  const isToggle = complexity === true || complexity === false;
  const overrides = isToggle ? EMPTY_THRESHOLDS : complexity;
  const complexityThresholds: ComplexityThresholds = {
    ...DEFAULT_COMPLEXITY_THRESHOLDS,
    ...overrides,
  };
  const complexitySeverity = severityOf(
    isToggle ? complexity : (overrides.severity ?? true),
    "warn",
  );
  const antiSlopSeverity = severityOf(options.antiSlop, "warn");

  return defineConfig({
    extends: [
      basePreset(severityOf(options.importCycles, "error")),
      options.typeAware === false ? null : typeAwarePreset(),
      antiSlopSeverity === "off" ? null : antiSlopPreset(antiSlopSeverity),
      complexitySeverity === "off"
        ? null
        : complexityPreset(complexityThresholds, complexitySeverity),
      options.importSorting === false ? null : importSortingPreset(),
    ].filter((config) => config !== null),
    rules: {
      "typescript/no-floating-promises":
        options.typeAware === false ? "off" : "error",
    },
  });
}
