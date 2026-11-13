import type { ESTree, SourceCode } from "@oxlint/plugins";

import { isGlobalName, variableOf } from "./binding-origin.ts";
import { declaredFunctionOf, guardsParameterAt } from "./brand-probe.ts";
import { functionParameterBindingName } from "./function-parameters.ts";
import { declaresParsedType, type FunctionFacts, promisedType } from "./parse-boundary.ts";
import type { RuntimeFunction } from "./type-guards.ts";

export type Name = Extract<ESTree.Node, { type: "Identifier" }>;
type Binary = Extract<ESTree.Node, { type: "BinaryExpression" }>;

/** The parameter whose reads are judged: the function that owns it, its position there, and the identifiers that refer to it. */
interface ParameterReads {
	readonly owner: RuntimeFunction;
	readonly position: number;
	readonly references: ReadonlySet<ESTree.Node>;
	readonly sourceCode: SourceCode;
}

/** No type test on the parameter holds. */
const UNTESTED = 0;
/** A type test holds that leaves a type TypeScript lets into a narrower one unchecked: `any[]`, a class with `any` type arguments, `object`, `Function`. */
const LOOSE = 1;
/** A type test holds that leaves a primitive, or the type a predicate names. */
const PRECISE = 2;

/** How much the type tests that hold at a read tell about the parameter. */
type Precision = typeof UNTESTED | typeof LOOSE | typeof PRECISE;

/** Return what holds where two tests both hold: the narrower of the two. */
function narrower(first: Precision, second: Precision): Precision {
	return first > second ? first : second;
}

/** Return what holds where one of two tests holds: the looser of the two. */
function looser(first: Precision, second: Precision): Precision {
	return first < second ? first : second;
}

/** How a test narrows the parameter on each branch: where the test held, where it failed. */
interface Narrowing {
	readonly truthy: Precision;
	readonly falsy: Precision;
}

const NONE: Narrowing = { truthy: UNTESTED, falsy: UNTESTED };

/** Names an imported function is trusted as a type guard by: `isX` or `IsX`, called with one argument. TypeScript rejects a narrowed read after one that is not a predicate. */
const IMPORTED_GUARD_NAME = /^[Ii]s[A-Z0-9_$]/;

/** What `typeof` answers for a primitive, which a test against it narrows to precisely. `"object"` and `"function"` leave `object` and `Function`. */
const PRIMITIVE_TYPEOF: ReadonlySet<string> = new Set(["bigint", "boolean", "number", "string", "symbol", "undefined"]);

const EQUALITY: ReadonlySet<string> = new Set(["===", "!==", "==", "!="]);
const POSITIVE_EQUALITY: ReadonlySet<string> = new Set(["===", "=="]);

/** Nodes a test outside does not narrow inside: a function declaration, hoisted above the test, and a class body with its methods, accessors and property initializers. */
const NARROWING_BARRIERS: ReadonlySet<string> = new Set(["FunctionDeclaration", "ClassBody"]);

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
 * Return how a call narrows its argument at `position`: loosely for `Array.isArray`, which leaves `any[]`; precisely for a
 * function declared in this file whose type predicate names the parameter at that position, and for an `isX` imported from
 * another module called with that argument alone.
 */
function guardPrecision(call: ESTree.CallExpression, position: number, sourceCode: SourceCode): Precision {
	const { callee } = call;
	if (isGlobalMember(callee, "Array", "isArray", sourceCode)) return position === 0 ? LOOSE : UNTESTED;
	if (callee.type !== "Identifier") return UNTESTED;
	const declared = declaredFunctionOf(callee, sourceCode);
	if (declared !== null) return guardsParameterAt(declared, position) ? PRECISE : UNTESTED;
	const imported = variableOf(callee, sourceCode)?.defs[0]?.type === "ImportBinding";
	return imported && position === 0 && call.arguments.length === 1 && IMPORTED_GUARD_NAME.test(callee.name) ? PRECISE : UNTESTED;
}

/** Return whether a call is a type guard on its argument at `position`, see `guardPrecision`. */
export function guardsArgument(call: ESTree.CallExpression, position: number, sourceCode: SourceCode): boolean {
	return guardPrecision(call, position, sourceCode) !== UNTESTED;
}

/** Return how a comparison of `typeof` of the parameter with a string literal narrows it: precisely to a primitive, loosely otherwise. */
function typeofPrecision(test: Binary, reads: ParameterReads): Precision {
	const sides = [test.left, test.right];
	if (!sides.some((side) => side.type === "UnaryExpression" && side.operator === "typeof" && reads.references.has(side.argument))) return UNTESTED;
	const named = sides.flatMap((side) => (side.type === "Literal" && typeof side.value === "string" ? [side.value] : []));
	if (named.length === 0) return UNTESTED;
	return named.every((each) => PRIMITIVE_TYPEOF.has(each)) ? PRECISE : LOOSE;
}

function binaryNarrowing(test: Binary, reads: ParameterReads): Narrowing {
	if (test.operator === "instanceof") return reads.references.has(test.left) ? { truthy: LOOSE, falsy: UNTESTED } : NONE;
	if (!EQUALITY.has(test.operator)) return NONE;
	const precision = typeofPrecision(test, reads);
	return POSITIVE_EQUALITY.has(test.operator) ? { truthy: precision, falsy: UNTESTED } : { truthy: UNTESTED, falsy: precision };
}

/**
 * Return how a test narrows the parameter. A guard call, `instanceof` and `typeof p === "lit"` narrow where they hold;
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
			if (test.operator === "&&") return { truthy: narrower(left.truthy, right.truthy), falsy: looser(left.falsy, right.falsy) };
			if (test.operator === "||") return { truthy: looser(left.truthy, right.truthy), falsy: narrower(left.falsy, right.falsy) };
			return NONE;
		}
		case "CallExpression": {
			const truthy = test.arguments.reduce<Precision>(
				(found, argument, position) => (reads.references.has(argument) ? narrower(found, guardPrecision(test, position, reads.sourceCode)) : found),
				UNTESTED,
			);
			return { truthy, falsy: UNTESTED };
		}
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

/** Return how the `if`s with no `else` before a statement of a block, which leave the function unless a test holds, narrow the parameter there. */
function exitingGuardNarrowing(block: ESTree.BlockStatement, statement: ESTree.Node, reads: ParameterReads): Precision {
	const index = block.body.findIndex((each) => each === statement);
	return block.body
		.slice(0, index)
		.reduce<Precision>(
			(found, earlier) =>
				earlier.type === "IfStatement" && earlier.alternate === null && exits(earlier.consequent) ? narrower(found, narrowingOf(earlier.test, reads).falsy) : found,
			UNTESTED,
		);
}

/** Return how `parent` narrows the parameter for its part `child`: a branch, the right of `&&` or `||`, or a statement after an exiting guard. */
function partNarrowing(parent: ESTree.Node, child: ESTree.Node, reads: ParameterReads): Precision {
	switch (parent.type) {
		case "IfStatement":
		case "ConditionalExpression":
			if (child === parent.consequent) return narrowingOf(parent.test, reads).truthy;
			return child === parent.alternate ? narrowingOf(parent.test, reads).falsy : UNTESTED;
		case "LogicalExpression":
			if (child !== parent.right) return UNTESTED;
			if (parent.operator === "&&") return narrowingOf(parent.left, reads).truthy;
			return parent.operator === "||" ? narrowingOf(parent.left, reads).falsy : UNTESTED;
		case "BlockStatement":
			return exitingGuardNarrowing(parent, child, reads);
		default:
			return UNTESTED;
	}
}

/** Return how the tests that hold at a read narrow the parameter, in the owner or an arrow, function expression or object method inside it. */
function narrowingAt(read: Name, reads: ParameterReads): Precision {
	let found: Precision = UNTESTED;
	for (let child: ESTree.Node = read; child !== reads.owner && child.parent !== null && !NARROWING_BARRIERS.has(child.type); child = child.parent) {
		found = narrower(found, partNarrowing(child.parent, child, reads));
	}
	return found;
}

/** Return the expression a read's value leaves by: the read, or the `?:` branch, `&&`, `||`, `??` or `await` it flows out through. */
function outflowOf(read: Name): ESTree.Node {
	let value: ESTree.Node = read;
	while (
		value.parent !== null &&
		(value.parent.type === "LogicalExpression" ||
			value.parent.type === "AwaitExpression" ||
			(value.parent.type === "ConditionalExpression" && value.parent.test !== value))
	) {
		value = value.parent;
	}
	return value;
}

/**
 * Return whether a read hands its value on where TypeScript lets a loose type in unchecked: returned, yielded, called,
 * constructed, assigned, or held in a `const` with no annotation.
 */
function handsOnLooseValue(read: Name): boolean {
	const value = outflowOf(read);
	const holder = value.parent;
	switch (holder?.type) {
		case "ReturnStatement":
		case "YieldExpression":
			return true;
		case "ArrowFunctionExpression":
			return holder.body === value;
		case "CallExpression":
		case "NewExpression":
			return holder.callee === value;
		case "TaggedTemplateExpression":
			return holder.tag === value;
		case "AssignmentExpression":
		case "AssignmentPattern":
			return holder.right === value;
		case "VariableDeclarator":
			return holder.init === value && holder.id.typeAnnotation?.typeAnnotation === undefined;
		default:
			return false;
	}
}

/**
 * A read that sits where a type test on the parameter holds, in the owner or a closure inside it. Under a precise test any use
 * is accepted there; under a loose one, any use that does not hand the value on as is.
 */
function isNarrowedRead(read: Name, reads: ParameterReads): boolean {
	const precision = narrowingAt(read, reads);
	return precision === PRECISE || (precision === LOOSE && !handsOnLooseValue(read));
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

/** A read passed back to the function itself at the parameter's own position, with no spread before it, so the same check judges it there. */
function isRecursiveArgument(read: Name, reads: ParameterReads): boolean {
	const user = read.parent;
	return (
		user.type === "CallExpression" &&
		user.arguments[reads.position] === read &&
		user.arguments.slice(0, reads.position).every((argument) => argument.type !== "SpreadElement") &&
		declaredFunctionOf(user.callee, reads.sourceCode) === reads.owner
	);
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

/** Return the declarator a read's value initializes, through the branches of `?:`, the operands of `&&`, `||` and `??`, and `await`. */
function declaratorHolding(read: Name): ESTree.VariableDeclarator | null {
	const value = outflowOf(read);
	const holder = value.parent;
	return holder?.type === "VariableDeclarator" && holder.init === value ? holder : null;
}

/** Return whether a type states only that a value is an array, claiming nothing of its items: `unknown[]` or `readonly unknown[]`. */
function isUnknownArray(type: ESTree.TSType): boolean {
	if (type.type === "TSTypeOperator" && type.operator === "readonly") return isUnknownArray(type.typeAnnotation);
	return type.type === "TSArrayType" && type.elementType.type === "TSUnknownKeyword";
}

/**
 * Return whether a read is recast: wrapped in `as`, `<T>`, `satisfies` or `!`, directly or around the `?:`, `&&`, `||`,
 * `??` or `await` it flows out through, or held in a `let`, a `var`, or a `const` annotated with a type other than
 * `unknown[]`. TypeScript lets an `object` into a type whose members are all optional without checking one of them, so such
 * an annotation is a cast.
 */
function isRecast(read: Name): boolean {
	if (CASTS.has(read.parent.type) || CASTS.has(outflowOf(read).parent?.type ?? "")) return true;
	const declarator = declaratorHolding(read);
	if (declarator === null) return false;
	const declared = declarator.id.typeAnnotation?.typeAnnotation;
	const declaration = declarator.parent;
	return declaration.type !== "VariableDeclaration" || declaration.kind !== "const" || (declared !== undefined && !isUnknownArray(declared));
}

/** Union members that leave a verdict a verdict: `boolean | undefined` still answers yes, no or nothing. */
const NO_ANSWER_TYPES: ReadonlySet<string> = new Set(["TSUndefinedKeyword", "TSNullKeyword", "TSVoidKeyword"]);

/**
 * Return whether a declared return type answers yes or no about the input rather than hand back a value parsed from it:
 * `boolean`, `true` or `false`, a type predicate or `asserts` clause on any parameter, or a union of them, also with
 * `undefined`, `null` or `void`.
 */
export function answersVerdict(type: ESTree.TSType): boolean {
	switch (type.type) {
		case "TSBooleanKeyword":
		case "TSTypePredicate":
			return true;
		case "TSLiteralType":
			return type.literal.type === "Literal" && typeof type.literal.value === "boolean";
		case "TSUnionType":
			return type.types.some(answersVerdict) && type.types.every((member) => answersVerdict(member) || NO_ANSWER_TYPES.has(member.type));
		case "TSParenthesizedType":
			return answersVerdict(type.typeAnnotation);
		default:
			return false;
	}
}

/** Return whether a function declares that it hands back a value parsed from its input: not `unknown`, `any`, `void` or a verdict, promised or not. */
function handsBackParsedValue(owner: RuntimeFunction): boolean {
	const handed = promisedType(owner.returnType);
	return handed !== undefined && handed.type !== "TSVoidKeyword" && !answersVerdict(handed) && declaresParsedType(owner.returnType);
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
 * `unknown`, `any`, `void` or a verdict, never reassigns the parameter, never mentions `arguments` or `eval`, tests the
 * parameter's type or converts it to text at least once, and reads it each time as a type test's operand, a side of an
 * equality, an argument to itself at its own position, the first argument of `String` or `JSON.stringify`, or where a type
 * test on it holds, short of handing the value on as is where only a loose test holds. A recast of it anywhere, or a property
 * read, a call argument or a store where no type test holds, is not one.
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
	const position = owner.params
		.filter((parameter) => parameter.type !== "Identifier" || parameter.name !== "this")
		.findIndex((parameter) => functionParameterBindingName(parameter, sourceCode) === name);
	const reads: ParameterReads = { owner, position, references: new Set(identifiers), sourceCode };
	return (
		identifiers.some((read) => isTypeTestOperand(read, reads) || isTotalStringConversion(read, reads)) &&
		identifiers.every((read) => !isRecast(read) && ALLOWED_READS.some((allowed) => allowed(read, reads)))
	);
}
