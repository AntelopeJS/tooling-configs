import type { ESTree, SourceCode, Variable } from "@oxlint/plugins";

import { variableOf } from "./binding-origin.ts";
import { argumentParameters, containsUnknownType, functionParameterTypeAnnotation } from "./function-parameters.ts";
import { isRuntimeFunction } from "./type-guards.ts";

type Name = Extract<ESTree.Node, { type: "Identifier" }>;

/** Return whether an identifier is a catch clause's own binding, never reassigned, so it holds exactly what was thrown. */
function isCaughtValue(node: ESTree.Node, sourceCode: SourceCode): boolean {
	if (node.type !== "Identifier") return false;
	const definition = variableOf(node, sourceCode)?.defs[0];
	if (definition?.type !== "CatchClause" || definition.node.type !== "CatchClause") return false;
	return (
		definition.node.param?.type === "Identifier" &&
		definition.node.param.name === node.name &&
		variableOf(node, sourceCode)?.references.every((reference) => !reference.isWrite()) === true
	);
}

/** Return whether a use of a callback leaves it unable to run with anything but what a call site passes: a plain test of whether it exists. */
function isExistenceTest(reference: Name): boolean {
	const user = reference.parent;
	return (
		(user.type === "ConditionalExpression" && user.test === reference) ||
		(user.type === "IfStatement" && user.test === reference) ||
		(user.type === "LogicalExpression" && user.operator === "&&" && user.left === reference)
	);
}

/** Return whether a call hands a caught value to every parameter of the callback type that is `unknown`. */
function passesCaughtValues(call: ESTree.CallExpression, unknownPositions: readonly number[], sourceCode: SourceCode): boolean {
	return (
		unknownPositions.every((position) => {
			const argument = call.arguments[position];
			return argument !== undefined && isCaughtValue(argument, sourceCode);
		})
	);
}

function parameterVariable(owner: ESTree.Node, parameter: Name, sourceCode: SourceCode): Variable | undefined {
	return sourceCode
		.getDeclaredVariables(owner)
		.find((variable) => variable.name === parameter.name && variable.defs[0]?.type === "Parameter");
}

/**
 * Return whether a function type is the type of a callback parameter that the function only calls with a caught value.
 * The callback parameter is a plain identifier of a function that has a body, its type is written directly as a function
 * type, it is called at least once, and every use of it is such a call (with a caught value in each `unknown` position of
 * the type) or a test of whether it exists. A callback that is stored, passed on, never called, or called with any other
 * value is not one: the thrown value has no type JavaScript promises, so `unknown` is the true type only there.
 */
export function isCaughtValueCallbackType(owner: ESTree.TSFunctionType, sourceCode: SourceCode): boolean {
	const annotation = owner.parent;
	if (annotation.type !== "TSTypeAnnotation") return false;
	const callback = annotation.parent;
	if (callback.type !== "Identifier") return false;
	const holder = callback.parent;
	if (!isRuntimeFunction(holder) || holder.body === null || holder.body === undefined) return false;
	const unknownPositions = argumentParameters(owner).flatMap((parameter, position) => {
		const type = functionParameterTypeAnnotation(parameter)?.typeAnnotation;
		return type !== undefined && containsUnknownType(type) ? [position] : [];
	});
	const reads = parameterVariable(holder, callback, sourceCode)?.references.filter((reference) => !reference.init);
	if (reads === undefined) return false;
	const calls = reads.filter((reference) => !isExistenceTest(reference.identifier));
	return (
		calls.length > 0 &&
		calls.every((reference) => {
			const call = reference.identifier.parent;
			return call.type === "CallExpression" && call.callee === reference.identifier && passesCaughtValues(call, unknownPositions, sourceCode);
		})
	);
}
