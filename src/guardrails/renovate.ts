/** The Renovate config file sync writes when a repository has none. */
export const RENOVATE_PATH = "renovate.json";

/** The repository config files Renovate reads, `renovate.json` first. */
export const RENOVATE_CONFIGS = [
  RENOVATE_PATH,
  "renovate.json5",
  ".github/renovate.json",
  ".github/renovate.json5",
  ".renovaterc",
  ".renovaterc.json",
] as const;

/** Matches a config that extends the AntelopeJS shared Renovate preset. */
export const RENOVATE_PRESET = /github>AntelopeJS\/\.github(?::|\/)/;

/** The `renovate.json` sync writes, already in oxfmt's JSON style. */
export const RENOVATE_JSON = `{
  "$schema": "https://docs.renovatebot.com/renovate-schema.json",
  "extends": ["github>AntelopeJS/.github:renovate.json5"]
}
`;
