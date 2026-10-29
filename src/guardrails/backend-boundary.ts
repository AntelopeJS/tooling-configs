import type { PlannedArtifact } from "./sync.ts";

/** Where a DMS frontend layer keeps its backend boundary plugin, relative to the layer. */
export const BACKEND_BOUNDARY_FILE = "build/backend-boundary.ts";

/** The backend boundary plugin a DMS frontend layer registers in `dms.frontend.build.ts`, for the package that holds the layer. */
export function backendBoundarySource(backendPackage: string): string {
  return `import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import type { Plugin } from "vite";

const BACKEND_PACKAGE = ${JSON.stringify(backendPackage)};
const BACKEND_SOURCE = "src";
const QUERY_OR_HASH = /[?#].*$/;

const backendRoots = new Map<string, string | null>();

function packageName(manifest: string): string | undefined {
	try {
		const parsed: { name?: string } = JSON.parse(
			readFileSync(manifest, "utf8"),
		);
		return parsed.name;
	} catch {
		return undefined;
	}
}

function backendRoot(directory: string): string | null {
	const known = backendRoots.get(directory);
	if (known !== undefined) return known;
	const manifest = join(directory, "package.json");
	const parent = dirname(directory);
	let root: string | null = null;
	if (existsSync(manifest)) {
		root = packageName(manifest) === BACKEND_PACKAGE ? directory : null;
	} else if (parent !== directory) {
		root = backendRoot(parent);
	}
	backendRoots.set(directory, root);
	return root;
}

function backendSourceFile(id: string): string | undefined {
	const path = id.replace(QUERY_OR_HASH, "");
	if (!isAbsolute(path)) return undefined;
	let real: string;
	try {
		real = realpathSync(path);
	} catch {
		return undefined;
	}
	const root = backendRoot(dirname(real));
	if (root === null) return undefined;
	return relative(root, real).split(sep)[0] === BACKEND_SOURCE
		? real
		: undefined;
}

export function backendBoundary(): Plugin {
	return {
		name: "dms-ai:backend-boundary",
		enforce: "pre",
		async resolveId(source, importer, options) {
			const resolved = await this.resolve(source, importer, {
				...options,
				skipSelf: true,
			});
			if (resolved === null || resolved.external) return resolved;
			const file = backendSourceFile(resolved.id);
			if (file === undefined) return resolved;
			const from =
				importer === undefined
					? "an entry point"
					: importer.replace(QUERY_OR_HASH, "");
			return this.error(
				\`Backend boundary: \${from} imports \${file}, which is under src of \${BACKEND_PACKAGE}. The frontend reaches the backend only through its HTTP routes.\`,
			);
		},
	};
}
`;
}

/** The sync plan for every tracked backend boundary plugin under `root`. */
export function backendBoundaryArtifacts(_root: string): PlannedArtifact[] {
  return [];
}
