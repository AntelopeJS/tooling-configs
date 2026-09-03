/** Paths every AntelopeJS project generates or vendors, and that no linter should read. */
export const IGNORE_PATTERNS = [
  "**/node_modules/**",
  "**/dist/**",
  "**/build/**",
  "**/coverage/**",
  "**/.antelope/**",
  "**/.nuxt/**",
  "**/.output/**",
  "**/output/**",
  "**/generated-layers.json",
  "**/i18n-registry.generated.ts",
];

/** Agent tooling directories: assets we install, not source we own. */
export const AGENT_IGNORE_PATTERNS = [
  ".agent/**",
  ".agents/**",
  ".amp/**",
  ".claude/**",
  ".codex/**",
  ".cursor/**",
  ".gemini/**",
  ".opencode/**",
  ".windsurf/**",
];
