import type { ESTree, SourceCode, Variable } from "@oxlint/plugins";

import { variableOf } from "./binding-origin.ts";
import { declaredFunctionOf } from "./brand-probe.ts";
import { argumentParameters, functionParameterTypeAnnotation } from "./function-parameters.ts";
import { answersVerdict, convertsToText, guardsArgument, type Name, unknownParameterReads } from "./guarded-reads.ts";
import { calleeName, DECODER_NAME, declaresParsedType, type FunctionFacts, promisedType, writesProperties } from "./parse-boundary.ts";
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

/** Return the object a member callee is read from, through further members, calls and type wrappers: `this` for `this.a?.b`, `p` for `p.a().b`. */
function rootOf(node: ESTree.Node): ESTree.Node {
	switch (node.type) {
		case "MemberExpression":
			return rootOf(node.object);
		case "CallExpression":
			return rootOf(node.callee);
		case "ChainExpression":
		case "TSAsExpression":
		case "TSNonNullExpression":
		case "TSSatisfiesExpression":
		case "TSTypeAssertion":
			return rootOf(node.expression);
		default:
			return node;
	}
}

/**
 * Return whether a value is rooted at a parameter, which would make a member of it a callee the caller hands in: read from a
 * parameter, or from a variable whose initializer, destructuring source or assigned value is rooted at one, transitively, through
 * either operand of `&&`, `||` and `??`, either branch of `?:`, and `await`.
 */
function isRootedAtParameter(node: ESTree.Node, sourceCode: SourceCode, seen: ReadonlySet<Variable>): boolean {
	const root = rootOf(node);
	const rooted = (each: ESTree.Node) => isRootedAtParameter(each, sourceCode, seen);
	if (root.type === "LogicalExpression") return rooted(root.left) || rooted(root.right);
	if (root.type === "ConditionalExpression") return rooted(root.consequent) || rooted(root.alternate);
	if (root.type === "AwaitExpression") return rooted(root.argument);
	const variable = root.type === "Identifier" ? variableOf(root, sourceCode) : null;
	if (variable === null || seen.has(variable)) return false;
	if (variable.defs[0]?.type === "Parameter") return true;
	const traced = new Set([...seen, variable]);
	return writtenValues(variable).some((value) => isRootedAtParameter(value, sourceCode, traced));
}

/** Return the values a variable is initialized, destructured or assigned from. oxlint leaves `writeExpr` undefined on a read, so only writes are asked. */
function writtenValues(variable: Variable): ESTree.Expression[] {
	return variable.references.flatMap((reference) => (reference.isWrite() && reference.writeExpr ? [reference.writeExpr] : []));
}

/** Return whether a function declared in this file declares its parameter at `position` exactly `unknown`. */
function takesUnknownAt(callee: RuntimeFunction, position: number): boolean {
	const parameter = argumentParameters(callee)[position];
	return (
		parameter !== undefined &&
		parameter.type !== "RestElement" &&
		functionParameterTypeAnnotation(parameter)?.typeAnnotation.type === "TSUnknownKeyword"
	);
}

/**
 * Return whether a call may take a forward at `position`: a member call that is not a collection store, not a property writer
 * such as `Object.assign`, and not rooted at a parameter, which would be a callee the caller hands in; an imported function; or
 * a function this file declares whose parameter there is exactly `unknown` and exempt from this rule. A forward back to a
 * parameter still under judgment is not exempt.
 */
function reachesTrustedCallee(call: ESTree.CallExpression, position: number, targets: ForwardTargets): boolean {
	const { callee } = call;
	const { sourceCode } = targets;
	if (callee.type === "MemberExpression") {
		if (STORE_METHODS.has(calleeName(call) ?? "") || writesProperties(call)) return false;
		return !isRootedAtParameter(callee, sourceCode, new Set());
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
 * type other than `unknown`, `any` or a verdict (see `answersVerdict`), promised or not. A callee this file declares must
 * declare that parameter exactly `unknown` and have it exempt. A member call or an imported callee is trusted unseen:
 * TypeScript rejects an `unknown` argument to any parameter narrower than `unknown` or `any`. One whose parameter is `any` is
 * not caught.
 */
export function forwardsOnly(
	owner: RuntimeFunction,
	name: string,
	annotated: ESTree.TSType,
	facts: FunctionFacts,
	targets: ForwardTargets,
): boolean {
	const handed = promisedType(owner.returnType);
	if (handed === undefined || answersVerdict(handed) || !declaresParsedType(owner.returnType)) return false;
	const reads = unknownParameterReads(owner, name, annotated, facts, targets.sourceCode);
	return reads !== null && reads.every((read) => isForward(read, targets));
}
