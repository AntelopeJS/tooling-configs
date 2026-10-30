import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import type { Plugin } from "vite";

const BACKEND_PACKAGE = "@antelopejs/dms-ai";
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

/**
 * The real path of a resolved module id when it lies under the `src`
 * directory of the backend package, or `undefined`. The package that owns the
 * file decides, not a path, so the answer is the same in the repository and in
 * the workspace the DMS builds the frontend in. Virtual ids and ids that are
 * not files are ignored.
 */
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

/**
 * Fails the build, the dev server and the tests when a module of the frontend
 * resolves to a file under the backend's `src`: the browser reaches the
 * backend only through its HTTP routes. It checks what the whole resolution
 * chain returns, so an alias is seen through and a symlink the resolver
 * returns is followed to its real path, and it runs before the other plugins
 * (`enforce: "pre"`).
 */
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
				`Backend boundary: ${from} imports ${file}, which is under src of ${BACKEND_PACKAGE}. The frontend reaches the backend only through its HTTP routes.`,
			);
		},
	};
}
