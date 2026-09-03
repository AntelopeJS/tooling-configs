//#region src/oxc/lint.d.ts
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
declare const ANTELOPE_IGNORE_PATTERNS: string[];
type Severity = "off" | "warn" | "error";
/**
 * Thresholds for the complexity rules. The defaults are deliberately looser than
 * oxlint's own (3 parameters, 50 lines per function): AntelopeJS handlers take a
 * request context plus its dependencies, and interface files declare long types.
 * They are meant to catch the outliers, not to redesign every signature.
 */
interface ComplexityThresholds {
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
declare const DEFAULT_COMPLEXITY_THRESHOLDS: ComplexityThresholds;
interface AntelopePresetOptions {
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
  complexity?: boolean | (Partial<ComplexityThresholds> & {
    severity?: Severity;
  });
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
declare function antelopePreset(options?: AntelopePresetOptions): {
  extends: ({
    categories: {
      correctness: "error";
    };
    ignorePatterns: string[];
    plugins: ("eslint" | "typescript" | "oxc" | "import" | "promise" | "node")[];
    rules: {
      "eslint/no-unused-vars": ["error", {
        argsIgnorePattern: "^_";
        varsIgnorePattern: "^_";
        caughtErrorsIgnorePattern: "^_";
      }];
      "import/no-cycle": Severity;
      "import/no-self-import": "error";
      "import/no-duplicates": "error";
    };
  } | {
    jsPlugins: {
      name: string;
      specifier: string;
    }[];
    rules: {
      [k: string]: Severity;
    };
  } | {
    rules: {
      "eslint/max-params": [Severity, {
        max: number;
      }];
      "eslint/max-lines-per-function": [Severity, {
        max: number;
        skipBlankLines: true;
        skipComments: true;
      }];
      "eslint/max-lines": [Severity, {
        max: number;
        skipBlankLines: true;
        skipComments: true;
      }];
      "eslint/max-depth": [Severity, {
        max: number;
      }];
      "eslint/complexity": [Severity, {
        max: number;
      }];
    };
  } | {
    jsPlugins: string[];
    rules: {
      "perfectionist/sort-imports": ["error", {
        type: "line-length";
        order: "asc";
        internalPattern: string[];
        groups: string[][];
      }];
    };
  })[];
  rules: {
    "typescript/no-floating-promises": "off" | "error";
  };
};
//#endregion
export { ANTELOPE_IGNORE_PATTERNS, AntelopePresetOptions, ComplexityThresholds, DEFAULT_COMPLEXITY_THRESHOLDS, antelopePreset };