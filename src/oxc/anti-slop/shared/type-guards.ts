import type { ESTree, SourceCode } from "@oxlint/plugins";

export type RuntimeFunction = ESTree.ArrowFunctionExpression | ESTree.Function;

/** JavaScript files, where TypeScript reads types from JSDoc instead of from syntax. */
export const JSDOC_TYPED_FILE = /\.[cm]?js$/;

/** A `@returns {x is T}` type, `x` captured: `asserts x is T` does not match. */
const JSDOC_PREDICATE = /^\s*([A-Za-z_$][\w$]*)\s+is\s+\S/;

export function isRuntimeFunction(node: ESTree.Node): node is RuntimeFunction {
	return (
		node.type === "ArrowFunctionExpression" ||
		node.type === "FunctionDeclaration" ||
		node.type === "FunctionExpression"
	);
}

/** Return the statement or member a JSDoc block documenting this function is attached to. */
function documentedNode(fn: RuntimeFunction): ESTree.Node {
	const parent = fn.parent;
	if ((parent.type === "Property" || parent.type === "MethodDefinition") && parent.value === fn) {
		return parent;
	}
	let node: ESTree.Node = fn;
	if (
		parent.type === "VariableDeclarator" &&
		parent.init === fn &&
		parent.parent.type === "VariableDeclaration" &&
		parent.parent.declarations.length === 1
	) {
		node = parent.parent;
	}
	const container = node.parent;
	return container !== null &&
		(container.type === "ExportNamedDeclaration" || container.type === "ExportDefaultDeclaration")
		? container
		: node;
}

/** Return the type inside the braces of the first `@<tag> {...}` tag of a JSDoc block. */
export function jsDocTagType(text: string, tag: "returns" | "type"): string | null {
	const match = new RegExp(String.raw`@${tag}\s*\{`, "u").exec(text);
	if (match === null) return null;
	const start = match.index + match[0].length;
	let depth = 1;
	for (let index = start; index < text.length; index++) {
		if (text[index] === "{") depth++;
		else if (text[index] === "}" && --depth === 0) return text.slice(start, index);
	}
	return null;
}

/** Return whether the JSDoc block right before the function declares `@returns {param is T}` for one of its parameters. */
function hasJsDocTypePredicate(fn: RuntimeFunction, sourceCode: SourceCode): boolean {
	const comment = sourceCode.getCommentsBefore(documentedNode(fn)).at(-1);
	if (comment === undefined || comment.type !== "Block" || !comment.value.startsWith("*")) {
		return false;
	}
	const returnType = jsDocTagType(comment.value, "returns");
	const subject = returnType === null ? undefined : JSDOC_PREDICATE.exec(returnType)?.[1];
	return (
		subject !== undefined &&
		fn.params.some((parameter) => parameter.type === "Identifier" && parameter.name === subject)
	);
}

/** Return whether a function declares a type predicate or assertion, or a JSDoc `@returns {x is T}` in a `.js`, `.mjs` or `.cjs` file. */
function isTypeGuard(fn: RuntimeFunction, sourceCode: SourceCode, filename: string): boolean {
	if (fn.returnType?.typeAnnotation.type === "TSTypePredicate") return true;
	return JSDOC_TYPED_FILE.test(filename) && hasJsDocTypePredicate(fn, sourceCode);
}

/** Return the nearest runtime function around a node when that function is a type guard. */
export function enclosingTypeGuard(
	node: ESTree.Node,
	sourceCode: SourceCode,
	filename: string,
): RuntimeFunction | null {
	let current: ESTree.Node | null = node.parent;
	while (current !== null && current.type !== "Program") {
		if (isRuntimeFunction(current)) {
			return isTypeGuard(current, sourceCode, filename) ? current : null;
		}
		current = current.parent;
	}
	return null;
}
