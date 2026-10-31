import type { ESTree, Reference, SourceCode } from "@oxlint/plugins";

import { containsUnknownType } from "./function-parameters.ts";
import type { RuntimeFunction } from "./type-guards.ts";

/**
 * Callee names that read as a schema or decoder: `parse`, `safeParse` and their `Async` forms, `decode`,
 * `parseX` and `decodeX` helpers in either case, and interface-api-util's `assertValidation`. A name proves
 * nothing alone, but a callee that takes `unknown` is checked where it is declared, so every chain of wrappers
 * ends at a schema library or at a reported parameter.
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

/** Return the decoder call whose direct argument a reference is. An `unknown` value is not callable, so it is never the callee. */
function decoderCallOf(identifier: Reference["identifier"]): ESTree.CallExpression | null {
	const call = identifier.parent;
	return call.type === "CallExpression" && DECODER_NAME.test(calleeName(call) ?? "") ? call : null;
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

/** Return the initializer of the single-name `const` an identifier refers to. */
function constInitializer(identifier: ESTree.IdentifierReference, sourceCode: SourceCode): ESTree.Expression | null {
	let scope: ReturnType<SourceCode["getScope"]> | null = sourceCode.getScope(identifier);
	while (scope !== null) {
		const variable = scope.set.get(identifier.name);
		if (variable !== undefined) {
			const declarator = variable.defs[0]?.node;
			return declarator?.type === "VariableDeclarator" &&
				declarator.id.type === "Identifier" &&
				declarator.parent.type === "VariableDeclaration" &&
				declarator.parent.kind === "const"
				? declarator.init
				: null;
		}
		scope = scope.upper;
	}
	return null;
}

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
 * to a schema or decoder, every value the function returns is such a call's result, and the function declares
 * a return type that states what it parsed. A function that stores, forwards, reads by hand or discards the
 * parsed value is not one.
 */
export function decodesParameterIntoResult(
	owner: RuntimeFunction,
	name: string,
	annotated: ESTree.TSType,
	returns: readonly ESTree.ReturnStatement[],
	sourceCode: SourceCode,
): boolean {
	if (annotated.type !== "TSUnknownKeyword" || !declaresParsedType(owner.returnType)) return false;
	const parameter = sourceCode
		.getDeclaredVariables(owner)
		.find((variable) => variable.name === name && variable.defs[0]?.type === "Parameter");
	const reads = parameter?.references.filter((reference) => !reference.init);
	const decoders: ReadonlySet<ESTree.Node | null> = new Set(reads?.map((reference) => decoderCallOf(reference.identifier)));
	if (decoders.has(null)) return false;
	const results = returnedExpressions(owner, returns);
	return (
		results.length > 0 &&
		results.every((result) => {
			if (result === null) return false;
			const source = parsedSource(result);
			if (source.type !== "Identifier") return decoders.has(source);
			const initializer = constInitializer(source, sourceCode);
			return initializer !== null && decoders.has(parsedSource(initializer));
		})
	);
}
