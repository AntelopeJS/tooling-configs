import type { ESTree, Reference, SourceCode, Variable } from "@oxlint/plugins";

import { variableOf } from "./binding-origin.ts";
import { calleeIsWrittenHere } from "./callee-origin.ts";
import { containsUnknownType } from "./function-parameters.ts";
import type { RuntimeFunction } from "./type-guards.ts";

/**
 * Callee names that read as a schema or decoder: `parse`, `safeParse` and their `Async` forms, `decode`,
 * `parseX` and `decodeX` helpers in either case, and interface-api-util's `assertValidation`. A name proves
 * nothing alone. A callee declared in the same file never counts (see `calleeIsWrittenHere`), so a chain of wrappers
 * cannot close on itself, and an imported callee that takes `unknown` is checked where it is declared.
 */
const DECODER_NAME = /^(?:assertValidation|safeParse(?:Async)?|[Pp]arse(?:[A-Z]\w*)?|[Dd]ecode(?:[A-Z]\w*)?)$/;

const PROMISE_TYPES: ReadonlySet<string> = new Set(["Promise", "PromiseLike"]);

function calleeName(call: ESTree.CallExpression): string | null {
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

/**
 * Return the decoder call whose direct argument a reference is. An `unknown` value is not callable, so it is
 * never the callee. A callee written in this file carries its own row and is no decoder.
 */
function decoderCallOf(identifier: Reference["identifier"], sourceCode: SourceCode): ESTree.CallExpression | null {
	const call = identifier.parent;
	return call.type === "CallExpression" && DECODER_NAME.test(calleeName(call) ?? "") && !calleeIsWrittenHere(call, sourceCode)
		? call
		: null;
}

/** Return whether a declared return type states a value, not `unknown` or `any`, promised or not. */
function declaresParsedType(annotation: ESTree.TSTypeAnnotation | null | undefined): boolean {
	const type = annotation?.typeAnnotation;
	if (type === undefined) return false;
	const promised =
		type.type === "TSTypeReference" && type.typeName.type === "Identifier" && PROMISE_TYPES.has(type.typeName.name)
			? type.typeArguments?.params[0]
			: type;
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
 * to a schema or decoder declared outside this file, every value the function returns is such a call's result,
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
