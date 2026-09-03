//#region src/knip.ts
const DEFAULT_ENTRY = [
	"src/index.ts",
	"src/interfaces/**/*.ts",
	"src/test/**/*.test.ts",
	"scripts/**/*.{ts,mjs}"
];
const DEFAULT_PROJECT = ["src/**/*.ts", "scripts/**/*.{ts,mjs}"];
const DEFAULT_IGNORE = [
	"dist/**",
	"nuxt-layer/**",
	"playground/**",
	".antelope/**"
];
function antelopeKnipConfig(options = {}) {
	return {
		entry: [...DEFAULT_ENTRY, ...options.entry ?? []],
		project: [...DEFAULT_PROJECT, ...options.project ?? []],
		ignore: [...DEFAULT_IGNORE, ...options.ignore ?? []],
		ignoreDependencies: options.ignoreDependencies ?? []
	};
}
//#endregion
export { antelopeKnipConfig };
