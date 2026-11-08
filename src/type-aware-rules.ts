/**
 * The typescript-eslint rules the preset runs with type information, by their
 * name without a plugin prefix. oxlint runs them as `typescript/<rule>` through
 * oxlint-tsgolint, which reads only TypeScript files; the Nuxt ESLint config
 * runs them as `@typescript-eslint/<rule>` on the script blocks of `.vue` files.
 *
 * Five reject an `any` or a type parameter that stands in for `unknown`, which
 * the anti-slop `unknown` and assertion rules never see: a once-used type
 * parameter, `any` passed as a typed argument, assigned to a typed binding or
 * returned as a typed result, and an untyped `.catch` callback variable.
 */
export const TYPE_AWARE_RULES = [
  "no-unnecessary-type-parameters",
  "no-unsafe-argument",
  "no-unsafe-assignment",
  "no-unsafe-return",
  "use-unknown-in-catch-callback-variable",
  "no-floating-promises",
  "await-thenable",
  "unbound-method",
  "no-meaningless-void-operator",
  "no-misused-spread",
  "no-base-to-string",
  "no-redundant-type-constituents",
  "restrict-template-expressions",
  "require-array-sort-compare",
] as const;
