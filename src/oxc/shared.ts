/**
 * Paths every AntelopeJS project generates or vendors, and that no linter should read.
 * `.github/ISSUE_TEMPLATE/**` holds GitHub's legacy issue templates: Markdown with
 * YAML frontmatter saved under a .yml extension, which a YAML formatter cannot parse.
 */
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
