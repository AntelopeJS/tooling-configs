import type { ESTree, Reference, SourceCode, Variable } from "@oxlint/plugins";

import { variableOf } from "./binding-origin.ts";
import { containsUnknownType } from "./function-parameters.ts";
import type { RuntimeFunction } from "./type-guards.ts";

/** Callee names that read as a decoder: `parse`, `safeParse` and their `Async` forms, `decode`, and `parseX` and `decodeX` in either case. */
export const DECODER_NAME = /^(?:safeParse(?:Async)?|[Pp]arse(?:[A-Z]\w*)?|[Dd]ecode(?:[A-Z]\w*)?)$/;

/** Packages whose exports are schemas or decoders. A subpath such as `zod/v4` counts as its package. */
const SCHEMA_LIBRARIES: readonly string[] = ["zod", "valibot", "yup", "joi", "superstruct", "io-ts", "@sinclair/typebox", "arktype", "effect", "@effect/schema"];

/** Calls that write properties of the object they are handed first. */
const PROPERTY_WRITERS: ReadonlySet<string> = new Set([
	"Object.assign",
	"Object.defineProperty",
	"Object.defineProperties",
	"Object.setPrototypeOf",
	"Reflect.set",
	"Reflect.defineProperty",
	"Reflect.setPrototypeOf",
]);

const PROMISE_TYPES: ReadonlySet<string> = new Set(["Promise", "PromiseLike"]);

/** Return the name a call is made by: an identifier callee's name, or a non-computed member callee's property name. */
export function calleeName(call: ESTree.CallExpression): string | null {
	const { callee } = call;
	if (callee.type === "Identifier") return callee.name;
	return callee.type === "MemberExpression" && !callee.computed && callee.property.type === "Identifier"
		? callee.property.name
		: null;
}

/** Return the initializer of the single-name `const` a variable declares. */
function constInitializerOf(variable: Variable | null): ESTree.Expression | null {
	const declarator = variable?.defs[0]?.node;
	return declarator?.type === "VariableDeclarator" &&
		declarator.id.type === "Identifier" &&
		declarator.parent.type === "VariableDeclaration" &&
		declarator.parent.kind === "const"
		? declarator.init
		: null;
}

function isSchemaLibrary(source: string): boolean {
	return SCHEMA_LIBRARIES.some((library) => source === library || source.startsWith(`${library}/`));
}

/** Return the `a.b` name of a non-computed member callee, or null. */
function dottedName(node: ESTree.Node): string | null {
	return node.type === "MemberExpression" && !node.computed && node.object.type === "Identifier" && node.property.type === "Identifier"
		? `${node.object.name}.${node.property.name}`
		: null;
}

/** Return the outermost member expression a reference is the object of, or the reference itself. */
function memberChainTop(identifier: Reference["identifier"]): ESTree.Node {
	let current: ESTree.Node = identifier;
	while (current.parent?.type === "MemberExpression" && current.parent.object === current) current = current.parent;
	return current;
}

/**
 * Return whether this file writes a property of a variable's value: an assignment, update or `delete` on a member read from it,
 * or a call such as `Object.assign` handed it first. A write through another name is not seen.
 */
function hasPropertyWrites(variable: Variable): boolean {
	return variable.references.some(({ identifier }) => {
		const top = memberChainTop(identifier);
		const holder = top.parent;
		if (holder === null) return false;
		if (top !== identifier) {
			if (holder.type === "AssignmentExpression" && holder.left === top) return true;
			if (holder.type === "UpdateExpression") return true;
			if (holder.type === "UnaryExpression" && holder.operator === "delete") return true;
		}
		return holder.type === "CallExpression" && holder.arguments[0] === top && PROPERTY_WRITERS.has(dottedName(holder.callee) ?? "");
	});
}

/** Return whether a variable is an import from a schema library, or a `const` whose initializer is rooted at one. */
function isSchemaVariable(variable: Variable, sourceCode: SourceCode, seen: ReadonlySet<Variable>): boolean {
	const [definition, ...others] = variable.defs;
	if (definition === undefined || others.length > 0 || seen.has(variable) || hasPropertyWrites(variable)) return false;
	if (variable.references.some((reference) => reference.isWrite() && !reference.init)) return false;
	if (definition.type === "ImportBinding") {
		const declaration = definition.parent;
		return declaration?.type === "ImportDeclaration" && isSchemaLibrary(declaration.source.value);
	}
	const initializer = constInitializerOf(variable);
	return initializer !== null && isRootedAtSchemaLibrary(initializer, sourceCode, new Set([...seen, variable]));
}

/** Return whether a value is read, through members, calls, type wrappers and `const` aliases, from a schema library's import. */
function isRootedAtSchemaLibrary(node: ESTree.Node, sourceCode: SourceCode, seen: ReadonlySet<Variable>): boolean {
	switch (node.type) {
		case "TSAsExpression":
		case "TSSatisfiesExpression":
		case "TSNonNullExpression":
		case "TSTypeAssertion":
		case "ChainExpression":
			return isRootedAtSchemaLibrary(node.expression, sourceCode, seen);
		case "MemberExpression":
			return isRootedAtSchemaLibrary(node.object, sourceCode, seen);
		case "CallExpression":
			return isRootedAtSchemaLibrary(node.callee, sourceCode, seen);
		case "Identifier": {
			const variable = variableOf(node, sourceCode);
			return variable !== null && isSchemaVariable(variable, sourceCode, seen);
		}
		default:
			return false;
	}
}

/**
 * Return the decoder call whose direct argument a reference is: a call of a decoder name read from a schema library's import.
 * An `unknown` value is not callable, so it is never the callee. A decoder of any other origin can do anything with the value.
 */
function decoderCallOf(identifier: Reference["identifier"], sourceCode: SourceCode): ESTree.CallExpression | null {
	const call = identifier.parent;
	return call.type === "CallExpression" && DECODER_NAME.test(calleeName(call) ?? "") && isRootedAtSchemaLibrary(call.callee, sourceCode, new Set())
		? call
		: null;
}

/** Return the type a declared return type hands back, read through `Promise<T>` and `PromiseLike<T>`. */
export function promisedType(annotation: ESTree.TSTypeAnnotation | null | undefined): ESTree.TSType | undefined {
	const type = annotation?.typeAnnotation;
	if (type === undefined) return undefined;
	return type.type === "TSTypeReference" && type.typeName.type === "Identifier" && PROMISE_TYPES.has(type.typeName.name)
		? type.typeArguments?.params[0]
		: type;
}

/** Return whether a declared return type states a value, not `unknown` or `any`, promised or not. */
export function declaresParsedType(annotation: ESTree.TSTypeAnnotation | null | undefined): boolean {
	const promised = promisedType(annotation);
	return promised !== undefined && promised.type !== "TSAnyKeyword" && !containsUnknownType(promised);
}

/** Strip what leaves a decoder's result the parsed value: `await` and the `.data` of a safe parse. */
function parsedSource(node: ESTree.Expression): ESTree.Expression {
	if (node.type === "AwaitExpression") return parsedSource(node.argument);
	const isData =
		node.type === "MemberExpression" &&
		!node.computed &&
		node.property.type === "Identifier" &&
		node.property.name === "data";
	return isData ? parsedSource(node.object) : node;
}

/** What the rule saw while it walked one function: its `return` statements, and whether its body can read a parameter without naming it. */
export interface FunctionFacts {
	readonly returns: readonly ESTree.ReturnStatement[];
	readonly readsImplicitly: boolean;
}

/** Names that read a parameter without a reference to it: the `arguments` object, and a direct `eval` that can name it in a string. */
export const IMPLICIT_READERS: ReadonlySet<string> = new Set(["arguments", "eval"]);

/** Return the expressions a function hands back: an arrow's expression body, or what its `return` statements return. */
function returnedExpressions(
	owner: RuntimeFunction,
	returns: readonly ESTree.ReturnStatement[],
): readonly (ESTree.Expression | null)[] {
	if (owner.body === null || owner.body === undefined) return [];
	return owner.body.type === "BlockStatement" ? returns.map((statement) => statement.argument) : [owner.body];
}

/**
 * Return whether a parameter typed exactly `unknown` is a parse boundary: every read of it is a direct argument
 * to a decoder read from a schema library, every value the function returns is such a call's result,
 * and the function declares a return type that states what it parsed. A function that stores, forwards, reads
 * by hand (through `arguments` or `eval` too) or discards the parsed value is not one.
 */
export function decodesParameterIntoResult(
	owner: RuntimeFunction,
	name: string,
	annotated: ESTree.TSType,
	facts: FunctionFacts,
	sourceCode: SourceCode,
): boolean {
	if (annotated.type !== "TSUnknownKeyword" || facts.readsImplicitly || !declaresParsedType(owner.returnType)) return false;
	const parameter = sourceCode
		.getDeclaredVariables(owner)
		.find((variable) => variable.name === name && variable.defs[0]?.type === "Parameter");
	const reads = parameter?.references.filter((reference) => !reference.init);
	const decoders: ReadonlySet<ESTree.Node | null> = new Set(reads?.map((reference) => decoderCallOf(reference.identifier, sourceCode)));
	if (decoders.has(null)) return false;
	const results = returnedExpressions(owner, facts.returns);
	return (
		results.length > 0 &&
		results.every((result) => {
			if (result === null) return false;
			const source = parsedSource(result);
			if (source.type !== "Identifier") return decoders.has(source);
			const initializer = constInitializerOf(variableOf(source, sourceCode));
			return initializer !== null && decoders.has(parsedSource(initializer));
		})
	);
}
