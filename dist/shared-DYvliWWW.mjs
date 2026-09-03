//#region src/oxc/shared.ts
/** Paths every AntelopeJS project generates or vendors, and that no linter should read. */
const IGNORE_PATTERNS = [
	"**/node_modules/**",
	"**/dist/**",
	"**/build/**",
	"**/coverage/**",
	"**/.antelope/**",
	"**/.nuxt/**",
	"**/.output/**",
	"**/output/**",
	"**/generated-layers.json",
	"**/i18n-registry.generated.ts"
];
/** Agent tooling directories: assets we install, not source we own. */
const AGENT_IGNORE_PATTERNS = [
	".agent/**",
	".agents/**",
	".amp/**",
	".claude/**",
	".codex/**",
	".cursor/**",
	".gemini/**",
	".opencode/**",
	".windsurf/**"
];
//#endregion
export { IGNORE_PATTERNS as n, AGENT_IGNORE_PATTERNS as t };
