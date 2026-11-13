import type { ESTree, SourceCode } from "@oxlint/plugins";

import { variableOf } from "./binding-origin.ts";
import { declaredFunctionOf } from "./brand-probe.ts";
import { functionParameterTypeAnnotation } from "./function-parameters.ts";
import { convertsToText, guardsArgument, type Name, unknownParameterReads } from "./guarded-reads.ts";
import { calleeName, DECODER_NAME, declaresParsedType, type FunctionFacts, promisedType } from "./parse-boundary.ts";
import type { RuntimeFunction } from "./type-guards.ts";

/** Where a forward may land: the file's source, and whether the rule exempts a parameter of a function the file declares. */
export interface ForwardTargets {
	readonly sourceCode: SourceCode;
	accepts(callee: RuntimeFunction, position: number): boolean;
}

/** Callee names that read as a validator: `assert` and `validate`, and `assertX` and `validateX`. */
const VALIDATOR_NAME = /^(?:[Aa]ssert|[Vv]alidate)(?:[A-Z]\w*)?$/;

/** Methods that keep a value in a collection. A call of one stores the value instead of handing it on. */
const STORE_METHODS: ReadonlySet<string> = new Set(["add", "push", "set", "splice", "unshift"]);

/** Return the object a member callee is read from, through further members and calls: `this` for `this.a?.b`, `p` for `p.a().b`. */
function rootOf(node: ESTree.Node): ESTree.Node {
	if (node.type === "MemberExpression") return rootOf(node.object);
	if (node.type === "CallExpression") return rootOf(node.callee);
	if (node.type === "ChainExpression" || node.type === "TSNonNullExpression") return rootOf(node.expression);
	return node;
}

/** Return whether a function declared in this file declares its parameter at `position` exactly `unknown`. */
function takesUnknownAt(callee: RuntimeFunction, position: number): boolean {
	const parameter = callee.params[position];
	return (
		parameter !== undefined &&
		parameter.type !== "RestElement" &&
		functionParameterTypeAnnotation(parameter)?.typeAnnotation.type === "TSUnknownKeyword"
	);
}

/**
 * Return whether a call may take a forward at `position`: a member call that is not a collection store and is not read from a
 * parameter, which would be a callee the caller hands in; an imported function; or a function this file declares whose parameter there is exactly `unknown` and
 * exempt from this rule. A forward back to a function still under judgment, the function itself included, is not exempt.
 */
function reachesTrustedCallee(call: ESTree.CallExpression, position: number, targets: ForwardTargets): boolean {
	const { callee } = call;
	const { sourceCode } = targets;
	if (callee.type === "MemberExpression") {
		const root = rootOf(callee);
		if (STORE_METHODS.has(calleeName(call) ?? "")) return false;
		return root.type !== "Identifier" || variableOf(root, sourceCode)?.defs[0]?.type !== "Parameter";
	}
	if (callee.type !== "Identifier") return false;
	const declared = declaredFunctionOf(callee, sourceCode);
	if (declared !== null) return takesUnknownAt(declared, position) && targets.accepts(declared, position);
	return variableOf(callee, sourceCode)?.defs[0]?.type === "ImportBinding";
}

/**
 * Return whether a read is handed on unread: a direct argument, not the callee, of a call that reaches a trusted callee and is
 * not a type guard, the global `String` or `JSON.stringify`, or a decoder or validator by name, which the parse-boundary
 * exemption judges.
 */
function isForward(read: Name, targets: ForwardTargets): boolean {
	const call = read.parent;
	if (call.type !== "CallExpression") return false;
	const position = call.arguments.findIndex((argument) => argument === read);
	if (position < 0 || convertsToText(call.callee, targets.sourceCode) || guardsArgument(call, position, targets.sourceCode)) return false;
	const name = calleeName(call) ?? "";
	if (DECODER_NAME.test(name) || VALIDATOR_NAME.test(name)) return false;
	return reachesTrustedCallee(call, position, targets);
}

/**
 * Return whether a parameter typed exactly `unknown` is only forwarded: every read of it is a direct argument of a call that
 * takes `unknown` there, the function never reassigns it and never mentions `arguments` or `eval`, and it declares a return
 * type other than `unknown`, `any` or `boolean`, promised or not. A callee this file declares must declare that parameter
 * exactly `unknown` and have it exempt. A member call or an imported callee is trusted unseen: TypeScript rejects an `unknown`
 * argument to any parameter narrower than `unknown` or `any`. One whose parameter is `any` is not caught.
 */
export function forwardsOnly(
	owner: RuntimeFunction,
	name: string,
	annotated: ESTree.TSType,
	facts: FunctionFacts,
	targets: ForwardTargets,
): boolean {
	const handed = promisedType(owner.returnType);
	if (handed === undefined || handed.type === "TSBooleanKeyword" || !declaresParsedType(owner.returnType)) return false;
	const reads = unknownParameterReads(owner, name, annotated, facts, targets.sourceCode);
	return reads !== null && reads.every((read) => isForward(read, targets));
}
