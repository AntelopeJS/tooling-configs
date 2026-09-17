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
  "**/i18n-registry.generated.ts",
  // GitHub's legacy issue templates are Markdown with YAML frontmatter saved
  // under a .yml extension, so a YAML formatter cannot parse them.
  ".github/ISSUE_TEMPLATE/**",
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
