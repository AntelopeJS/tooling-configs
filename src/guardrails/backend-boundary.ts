import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import ts from "typescript";

import { parseManifest } from "./package.ts";
import type { PlannedArtifact } from "./sync.ts";

/** Where a DMS frontend layer keeps its backend boundary plugin, relative to the layer. */
const BACKEND_BOUNDARY_FILE = "build/backend-boundary.ts";

/** The backend boundary plugin a DMS frontend layer registers in `dms.frontend.build.ts`, for the package that holds the layer. */
export function backendBoundarySource(backendPackage: string): string {
  return `import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import type { DmsVitePluginEntry } from '#dms/frontend-build'

type VitePlugin = Extract<DmsVitePluginEntry, { name: string }>

const BACKEND_PACKAGE = ${JSON.stringify(backendPackage)}
const BACKEND_SOURCE = 'src'
const QUERY_OR_HASH = /[?#].*$/

const backendRoots = new Map<string, string | null>()

/** Whether a parsed manifest names its package. */
function isNamedManifest(value: unknown): value is { name: string } {
	return (
		typeof value === 'object' &&
		value !== null &&
		'name' in value &&
		typeof value.name === 'string'
	)
}

/** The package name a \`package.json\` declares, or \`undefined\`. */
function packageName(manifest: string): string | undefined {
	try {
		const parsed: unknown = JSON.parse(readFileSync(manifest, 'utf8'))
		return isNamedManifest(parsed) ? parsed.name : undefined
	} catch {
		return undefined
	}
}

/** The directory of the backend package that holds \`directory\`, or null. */
function backendRoot(directory: string): string | null {
	const known = backendRoots.get(directory)
	if (known !== undefined) {
		return known
	}
	const manifest = join(directory, 'package.json')
	const parent = dirname(directory)
	let root: string | null = null
	if (existsSync(manifest)) {
		root = packageName(manifest) === BACKEND_PACKAGE ? directory : null
	} else if (parent !== directory) {
		root = backendRoot(parent)
	}
	backendRoots.set(directory, root)
	return root
}

/**
 * The real path of a resolved module id when it lies under the \`src\`
 * directory of the backend package, or \`undefined\`. The package that owns the
 * file decides, not a path, so the answer is the same in the repository and in
 * the build workspace. Virtual ids and ids that are not files are ignored.
 */
function backendSourceFile(id: string): string | undefined {
	const path = id.replace(QUERY_OR_HASH, '')
	if (!isAbsolute(path)) {
		return undefined
	}
	let real: string
	try {
		real = realpathSync(path)
	} catch {
		return undefined
	}
	const root = backendRoot(dirname(real))
	if (root === null) {
		return undefined
	}
	return relative(root, real).split(sep)[0] === BACKEND_SOURCE
		? real
		: undefined
}

/**
 * Fails the build and the dev server when a module of the frontend resolves to
 * a file under the \`src\` of the backend package: the browser reaches the
 * backend only through its HTTP interface. It checks what the whole resolution
 * chain returns, an id marked external included, so an alias is seen through
 * and a symlink the resolver returns is followed to its real path, and it runs
 * before the other plugins (\`enforce: "pre"\`). Vite builds workers with their
 * own plugin list, so the plugin adds itself there too.
 *
 * antelopejs-sync writes this file from \`@antelopejs/tooling-configs\` and
 * restores it on every run: change the plugin in the pack, not here.
 */
export function backendBoundary(): VitePlugin {
	return {
		...boundaryCheck(),
		config: () => ({ worker: { plugins: () => [boundaryCheck()] } }),
	}
}

/** The check alone, as a worker build runs it. */
function boundaryCheck(): VitePlugin {
	return {
		name: \`\${BACKEND_PACKAGE}:backend-boundary\`,
		enforce: 'pre',
		async resolveId(source, importer, options) {
			const resolved = await this.resolve(source, importer, {
				...options,
				skipSelf: true,
			})
			if (resolved === null) {
				return resolved
			}
			const file = backendSourceFile(resolved.id)
			if (file === undefined) {
				return resolved
			}
			const from =
				importer === undefined
					? 'an entry point'
					: importer.replace(QUERY_OR_HASH, '')
			return this.error(
				\`Backend boundary: \${from} imports \${file}, which is under the src of \${BACKEND_PACKAGE}. The frontend reaches the backend only through its HTTP interface.\`,
			)
		},
	}
}
`;
}

/** The syntax tree of `text` without trivia, parentheses or quote style, so a formatter's rewrite compares equal to the original. */
function formatFreeProgram(text: string): string {
  const parts: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isParenthesizedExpression(node) || ts.isParenthesizedTypeNode(node))
      return void ts.forEachChild(node, visit);
    parts.push(ts.SyntaxKind[node.kind]);
    if (
      ts.isIdentifier(node) ||
      ts.isPrivateIdentifier(node) ||
      ts.isLiteralExpression(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    )
      parts.push(JSON.stringify(node.text));
    ts.forEachChild(node, visit);
  };
  visit(
    ts.createSourceFile(
      "backend-boundary.ts",
      text,
      ts.ScriptTarget.Latest,
      false,
      ts.ScriptKind.TS,
    ),
  );
  return parts.join(" ");
}

/** The sync plan for every tracked backend boundary plugin under `root`: each one is the pack's plugin for the package that holds its layer, in any formatting. */
export function backendBoundaryArtifacts(root: string): PlannedArtifact[] {
  return execFileSync(
    "git",
    ["ls-files", "-z", "--", `:(glob)**/${BACKEND_BOUNDARY_FILE}`],
    { cwd: root, encoding: "utf8" },
  )
    .split("\0")
    .filter((path) => path && dirname(dirname(path)) !== ".")
    .map((path): PlannedArtifact => {
      const manifest = join(dirname(dirname(dirname(path))), "package.json");
      const name = existsSync(join(root, manifest))
        ? parseManifest(readFileSync(join(root, manifest), "utf8")).name
        : undefined;
      if (!name)
        return {
          kind: "error",
          path,
          message: `${path} guards the backend package ${manifest}, which has no name. Name that package, then rerun antelopejs-sync.`,
        };
      const content = backendBoundarySource(name);
      const current = existsSync(join(root, path))
        ? readFileSync(join(root, path), "utf8")
        : "";
      return formatFreeProgram(current) === formatFreeProgram(content)
        ? { kind: "unchanged", path }
        : { kind: "write", path, content, mode: undefined };
    });
}
