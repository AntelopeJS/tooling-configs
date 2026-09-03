//#region src/knip.ts
const DEFAULT_ENTRY = [
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
/**
* Every layer's CI runs `cd nuxt-layer && pnpm typecheck`. Knip parses the
* workflow, sees a binary it cannot resolve, and reports it: the script lives in
* the layer's own package.json, outside the analysed project.
*/
const DEFAULT_IGNORE_BINARIES = ["typecheck"];
function antelopeKnipConfig(options = {}) {
	return {
		entry: [...DEFAULT_ENTRY, ...options.entry ?? []],
		project: [...DEFAULT_PROJECT, ...options.project ?? []],
		ignore: [...DEFAULT_IGNORE, ...options.ignore ?? []],
		ignoreDependencies: options.ignoreDependencies ?? [],
		ignoreBinaries: [...DEFAULT_IGNORE_BINARIES, ...options.ignoreBinaries ?? []]
	};
}
//#endregion
export { antelopeKnipConfig };
