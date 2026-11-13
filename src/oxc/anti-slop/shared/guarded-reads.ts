import type { ESTree, SourceCode } from "@oxlint/plugins";

import { isGlobalName, variableOf } from "./binding-origin.ts";
import { declaredFunctionOf, guardsParameterAt } from "./brand-probe.ts";
import { declaresParsedType, type FunctionFacts, promisedType } from "./parse-boundary.ts";
import type { RuntimeFunction } from "./type-guards.ts";

export type Name = Extract<ESTree.Node, { type: "Identifier" }>;
type Binary = Extract<ESTree.Node, { type: "BinaryExpression" }>;

/** The parameter whose reads are judged: the function that owns it, and the identifiers that refer to it. */
interface ParameterReads {
	readonly owner: RuntimeFunction;
	readonly references: ReadonlySet<ESTree.Node>;
	readonly sourceCode: SourceCode;
}

/** On which branch of a test the parameter is narrowed: where the test held, where it failed. */
interface Narrowing {
	readonly truthy: boolean;
	readonly falsy: boolean;
}

const NONE: Narrowing = { truthy: false, falsy: false };
const ON_TRUTHY: Narrowing = { truthy: true, falsy: false };
const ON_FALSY: Narrowing = { truthy: false, falsy: true };

/** Names an imported function is trusted as a type guard by: `isX` or `IsX`. TypeScript rejects a narrowed read after one that is not a predicate. */
const IMPORTED_GUARD_NAME = /^[Ii]s[A-Z0-9_$]/;

const EQUALITY: ReadonlySet<string> = new Set(["===", "!==", "==", "!="]);
const POSITIVE_EQUALITY: ReadonlySet<string> = new Set(["===", "=="]);

/** Parents that change the type a read is seen at. A read under one of them is never accepted. */
const CASTS: ReadonlySet<string> = new Set(["TSAsExpression", "TSTypeAssertion", "TSSatisfiesExpression", "TSNonNullExpression"]);

/** Return whether a node is the non-computed member `object.property` of a global `object` no binding of the file shadows. */
function isGlobalMember(node: ESTree.Node, object: string, property: string, sourceCode: SourceCode): boolean {
	return (
		node.type === "MemberExpression" &&
		!node.computed &&
		node.object.type === "Identifier" &&
		node.object.name === object &&
		isGlobalName(node.object, sourceCode) &&
		node.property.type === "Identifier" &&
		node.property.name === property
	);
}

/**
 * Return whether a call is a type guard on its argument at `position`: `Array.isArray`, a function declared in this file whose
 * type predicate names the parameter at that position, or an `isX` imported from another module, on its first argument.
 */
export function guardsArgument(call: ESTree.CallExpression, position: number, sourceCode: SourceCode): boolean {
	const { callee } = call;
	if (isGlobalMember(callee, "Array", "isArray", sourceCode)) return position === 0;
	if (callee.type !== "Identifier") return false;
	const declared = declaredFunctionOf(callee, sourceCode);
	if (declared !== null) return guardsParameterAt(declared, position);
	return variableOf(callee, sourceCode)?.defs[0]?.type === "ImportBinding" && position === 0 && IMPORTED_GUARD_NAME.test(callee.name);
}

/** Return whether a comparison sets `typeof` of the parameter against a string literal. */
function comparesTypeof(test: Binary, reads: ParameterReads): boolean {
	const sides = [test.left, test.right];
	return (
		sides.some((side) => side.type === "UnaryExpression" && side.operator === "typeof" && reads.references.has(side.argument)) &&
		sides.some((side) => side.type === "Literal" && typeof side.value === "string")
	);
}

function binaryNarrowing(test: Binary, reads: ParameterReads): Narrowing {
	if (test.operator === "instanceof") return reads.references.has(test.left) ? ON_TRUTHY : NONE;
	if (!EQUALITY.has(test.operator) || !comparesTypeof(test, reads)) return NONE;
	return POSITIVE_EQUALITY.has(test.operator) ? ON_TRUTHY : ON_FALSY;
}

/**
 * Return where a test narrows the parameter. A guard call, `instanceof` and `typeof p === "lit"` narrow where they hold;
 * `!`, `typeof p !== "lit"` and the `&&` and `||` that join tests carry that through. A comparison with `null` narrows nowhere.
 */
function narrowingOf(test: ESTree.Node, reads: ParameterReads): Narrowing {
	switch (test.type) {
		case "UnaryExpression": {
			if (test.operator !== "!") return NONE;
			const inner = narrowingOf(test.argument, reads);
			return { truthy: inner.falsy, falsy: inner.truthy };
		}
		case "LogicalExpression": {
			const left = narrowingOf(test.left, reads);
			const right = narrowingOf(test.right, reads);
			if (test.operator === "&&") return { truthy: left.truthy || right.truthy, falsy: left.falsy && right.falsy };
			if (test.operator === "||") return { truthy: left.truthy && right.truthy, falsy: left.falsy || right.falsy };
			return NONE;
		}
		case "CallExpression":
			return test.arguments.some((argument, position) => reads.references.has(argument) && guardsArgument(test, position, reads.sourceCode))
				? ON_TRUTHY
				: NONE;
		case "BinaryExpression":
			return binaryNarrowing(test, reads);
		default:
			return NONE;
	}
}

/** Return whether a statement always leaves its function: a `return` or `throw`, or a block that ends in one. */
function exits(statement: ESTree.Statement | undefined): boolean {
	if (statement?.type === "BlockStatement") return exits(statement.body.at(-1));
	return statement?.type === "ReturnStatement" || statement?.type === "ThrowStatement";
}

/** Return whether a statement of a block follows an `if` with no `else` that leaves the function unless the parameter is narrowed. */
function followsExitingGuard(block: ESTree.BlockStatement, statement: ESTree.Node, reads: ParameterReads): boolean {
	const index = block.body.findIndex((each) => each === statement);
	return block.body
		.slice(0, index)
		.some((earlier) => earlier.type === "IfStatement" && earlier.alternate === null && narrowingOf(earlier.test, reads).falsy && exits(earlier.consequent));
}

/** Return whether `parent` narrows the parameter for its part `child`: a branch, the right of `&&` or `||`, or a statement after an exiting guard. */
function narrowsPart(parent: ESTree.Node, child: ESTree.Node, reads: ParameterReads): boolean {
	switch (parent.type) {
		case "IfStatement":
		case "ConditionalExpression":
			if (child === parent.consequent) return narrowingOf(parent.test, reads).truthy;
			return child === parent.alternate && narrowingOf(parent.test, reads).falsy;
		case "LogicalExpression":
			if (child !== parent.right) return false;
			if (parent.operator === "&&") return narrowingOf(parent.left, reads).truthy;
			return parent.operator === "||" && narrowingOf(parent.left, reads).falsy;
		case "BlockStatement":
			return followsExitingGuard(parent, child, reads);
		default:
			return false;
	}
}

/** A read that sits where a type test on the parameter holds, in the owner or a closure inside it. Any use is accepted there. */
function isNarrowedRead(read: Name, reads: ParameterReads): boolean {
	for (let child: ESTree.Node = read; child !== reads.owner && child.parent !== null; child = child.parent) {
		if (narrowsPart(child.parent, child, reads)) return true;
	}
	return false;
}

/** A read a type test is made of: a guard's argument, the left of `instanceof`, or the operand of `typeof`. */
function isTypeTestOperand(read: Name, reads: ParameterReads): boolean {
	const user = read.parent;
	switch (user.type) {
		case "CallExpression":
			return guardsArgument(
				user,
				user.arguments.findIndex((argument) => argument === read),
				reads.sourceCode,
			);
		case "BinaryExpression":
			return user.operator === "instanceof" && user.left === read;
		case "UnaryExpression":
			return user.operator === "typeof";
		default:
			return false;
	}
}

/** A read compared with `===`, `!==`, `==` or `!=`, which answers a boolean and narrows nothing this rule follows. */
function isEqualityOperand(read: Name): boolean {
	return read.parent.type === "BinaryExpression" && EQUALITY.has(read.parent.operator);
}

/** A read passed back to the function itself, which this rule judges on its own. */
function isRecursiveArgument(read: Name, reads: ParameterReads): boolean {
	const user = read.parent;
	return user.type === "CallExpression" && user.arguments.some((argument) => argument === read) && declaredFunctionOf(user.callee, reads.sourceCode) === reads.owner;
}

/** Return whether a callee is the global `String` or `JSON.stringify`, which take any value and return text. */
export function convertsToText(callee: ESTree.Node, sourceCode: SourceCode): boolean {
	return (
		(callee.type === "Identifier" && callee.name === "String" && isGlobalName(callee, sourceCode)) ||
		isGlobalMember(callee, "JSON", "stringify", sourceCode)
	);
}

/** A read handed as is, as the first argument, to the global `String(...)` or `JSON.stringify(...)`. */
function isTotalStringConversion(read: Name, reads: ParameterReads): boolean {
	const user = read.parent;
	return user.type === "CallExpression" && user.arguments[0] === read && convertsToText(user.callee, reads.sourceCode);
}

/** The positions a read of an unknown parameter may take without leaving it unparsed. */
const ALLOWED_READS: readonly ((read: Name, reads: ParameterReads) => boolean)[] = [
	isTypeTestOperand,
	isEqualityOperand,
	isRecursiveArgument,
	isTotalStringConversion,
	isNarrowedRead,
];

/** Return the declarator a read's value initializes, through the branches of `?:` and the operands of `&&`, `||` and `??`. */
function declaratorHolding(read: Name): ESTree.VariableDeclarator | null {
	let value: ESTree.Node = read;
	while (
		value.parent !== null &&
		(value.parent.type === "LogicalExpression" || (value.parent.type === "ConditionalExpression" && value.parent.test !== value))
	) {
		value = value.parent;
	}
	const holder = value.parent;
	return holder?.type === "VariableDeclarator" && holder.init === value ? holder : null;
}

/** Return whether a type states only that a value is an array, claiming nothing of its items: `unknown[]` or `readonly unknown[]`. */
function isUnknownArray(type: ESTree.TSType): boolean {
	if (type.type === "TSTypeOperator" && type.operator === "readonly") return isUnknownArray(type.typeAnnotation);
	return type.type === "TSArrayType" && type.elementType.type === "TSUnknownKeyword";
}

/**
 * Return whether a read is recast: wrapped in `as`, `<T>`, `satisfies` or `!`, or held in a `let`, a `var`, or a `const`
 * annotated with a type other than `unknown[]`. TypeScript lets an `object` into a type whose members are all optional
 * without checking one of them, so such an annotation is a cast.
 */
function isRecast(read: Name): boolean {
	if (CASTS.has(read.parent.type)) return true;
	const declarator = declaratorHolding(read);
	if (declarator === null) return false;
	const declared = declarator.id.typeAnnotation?.typeAnnotation;
	const declaration = declarator.parent;
	return declaration.type !== "VariableDeclaration" || declaration.kind !== "const" || (declared !== undefined && !isUnknownArray(declared));
}

/** Return types that answer about the input rather than hand back a value parsed from it. A yes-or-no answer is a type predicate's job. */
const VERDICT_TYPES: ReadonlySet<string> = new Set(["TSBooleanKeyword", "TSVoidKeyword"]);

/** Return whether a function declares that it hands back a value parsed from its input: not `unknown`, `any`, `boolean` or `void`, promised or not. */
function handsBackParsedValue(owner: RuntimeFunction): boolean {
	const handed = promisedType(owner.returnType);
	return handed !== undefined && !VERDICT_TYPES.has(handed.type) && declaresParsedType(owner.returnType);
}

/**
 * Return the reads of a parameter typed exactly `unknown` of a function with a body, when the function never reassigns it and
 * never mentions `arguments` or `eval`, and reads it at least once. Return null otherwise.
 */
export function unknownParameterReads(
	owner: RuntimeFunction,
	name: string,
	annotated: ESTree.TSType,
	facts: FunctionFacts,
	sourceCode: SourceCode,
): readonly Name[] | null {
	if (annotated.type !== "TSUnknownKeyword" || facts.readsImplicitly || owner.body === null || owner.body === undefined) return null;
	const parameter = sourceCode
		.getDeclaredVariables(owner)
		.find((variable) => variable.name === name && variable.defs[0]?.type === "Parameter");
	if (parameter === undefined || parameter.references.some((reference) => reference.isWrite() && !reference.init)) return null;
	const identifiers = parameter.references.filter((reference) => !reference.init).map((reference) => reference.identifier);
	return identifiers.length > 0 ? identifiers : null;
}

/**
 * Return whether a parameter typed exactly `unknown` is only classified: the function declares a return type other than
 * `unknown`, `any`, `boolean` or `void`, never reassigns the parameter, never mentions `arguments` or `eval`, tests the
 * parameter's type or converts it to text at least once, and reads it each time as a type test's operand, a side of an
 * equality, an argument to itself, the first argument of `String` or `JSON.stringify`, or where a type test on it holds. A
 * recast of it anywhere, or a property read, a call argument or a store where no type test holds, is not one.
 */
export function readsOnlyThroughGuards(
	owner: RuntimeFunction,
	name: string,
	annotated: ESTree.TSType,
	facts: FunctionFacts,
	sourceCode: SourceCode,
): boolean {
	const identifiers = handsBackParsedValue(owner) ? unknownParameterReads(owner, name, annotated, facts, sourceCode) : null;
	if (identifiers === null) return false;
	const reads: ParameterReads = { owner, references: new Set(identifiers), sourceCode };
	return (
		identifiers.some((read) => isTypeTestOperand(read, reads) || isTotalStringConversion(read, reads)) &&
		identifiers.every((read) => !isRecast(read) && ALLOWED_READS.some((allowed) => allowed(read, reads)))
	);
}
