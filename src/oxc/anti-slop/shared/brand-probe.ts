import type { ESTree, SourceCode, Variable } from "@oxlint/plugins";

import { isGlobalName, variableOf } from "./binding-origin.ts";
import { isRuntimeFunction, type RuntimeFunction } from "./type-guards.ts";

type Name = Extract<ESTree.Node, { type: "Identifier" }>;

/** Primitive types a probe may hand back: a derived value, never an object shape the function claims to know. */
const PRIMITIVE_TYPES: ReadonlySet<string> = new Set([
	"TSBigIntKeyword",
	"TSBooleanKeyword",
	"TSNullKeyword",
	"TSNumberKeyword",
	"TSStringKeyword",
	"TSSymbolKeyword",
	"TSUndefinedKeyword",
	"TSVoidKeyword",
]);

function isPrimitiveType(type: ESTree.TSType): boolean {
	if (type.type === "TSUnionType") return type.types.every(isPrimitiveType);
	if (type.type === "TSParenthesizedType") return isPrimitiveType(type.typeAnnotation);
	return PRIMITIVE_TYPES.has(type.type) || type.type === "TSLiteralType";
}

/** Return whether a call creates a symbol: `Symbol(...)` or `Symbol.for(...)` on the global `Symbol`. */
function createsSymbol(node: ESTree.Node | null | undefined, sourceCode: SourceCode): boolean {
	if (node === null || node === undefined || node.type !== "CallExpression") return false;
	const { callee } = node;
	const root =
		callee.type === "MemberExpression" && !callee.computed && callee.property.type === "Identifier" && callee.property.name === "for"
			? callee.object
			: callee;
	return root.type === "Identifier" && root.name === "Symbol" && isGlobalName(root, sourceCode);
}

/** Return whether an expression is a symbol this file creates: a `const` bound to `Symbol(...)` or `Symbol.for(...)`, or such a call. */
function isOwnSymbol(node: ESTree.Node, sourceCode: SourceCode): boolean {
	if (node.type !== "Identifier") return createsSymbol(node, sourceCode);
	const definition = variableOf(node, sourceCode)?.defs[0];
	const declarator = definition?.node;
	return (
		definition?.type === "Variable" &&
		declarator?.type === "VariableDeclarator" &&
		declarator.parent.type === "VariableDeclaration" &&
		declarator.parent.kind === "const" &&
		createsSymbol(declarator.init, sourceCode)
	);
}

/** Return whether a reference reads a symbol-keyed member of the value (`value[BRAND]`) or asks `BRAND in value`. */
function isProbe(reference: Name, sourceCode: SourceCode): boolean {
	const user = reference.parent;
	if (user.type === "MemberExpression") return user.object === reference && user.computed && isOwnSymbol(user.property, sourceCode);
	return user.type === "BinaryExpression" && user.operator === "in" && user.right === reference && isOwnSymbol(user.left, sourceCode);
}

/** Return the type-predicate subject a call position names, for a callee declared in this file. */
function declaredFunctionOf(callee: ESTree.Node, sourceCode: SourceCode): RuntimeFunction | null {
	if (callee.type !== "Identifier") return null;
	const definition = variableOf(callee, sourceCode)?.defs[0];
	if (definition?.type === "FunctionName" && isRuntimeFunction(definition.node)) return definition.node;
	const declarator = definition?.node;
	if (
		definition?.type === "Variable" &&
		declarator?.type === "VariableDeclarator" &&
		declarator.parent.type === "VariableDeclaration" &&
		declarator.parent.kind === "const" &&
		declarator.init !== null &&
		declarator.init !== undefined &&
		isRuntimeFunction(declarator.init)
	) {
		return declarator.init;
	}
	return null;
}

function parameterAt(owner: RuntimeFunction, position: number, sourceCode: SourceCode): Variable | null {
	const parameter = owner.params[position];
	if (parameter?.type !== "Identifier") return null;
	return sourceCode.getDeclaredVariables(owner).find((variable) => variable.name === parameter.name && variable.defs[0]?.type === "Parameter") ?? null;
}

/** Return whether a function declared in this file is a type guard on the parameter at `position`. */
function guardsParameterAt(owner: RuntimeFunction, position: number): boolean {
	const predicate = owner.returnType?.typeAnnotation;
	const parameter = owner.params[position];
	return (
		predicate?.type === "TSTypePredicate" &&
		!predicate.asserts &&
		predicate.parameterName.type === "Identifier" &&
		parameter?.type === "Identifier" &&
		predicate.parameterName.name === parameter.name
	);
}


/** Operators whose result is a boolean about the operands, which a probe may hand back. */
const COMPARISONS: ReadonlySet<string> = new Set(["===", "!==", "==", "!=", "<", ">", "<=", ">="]);

/** Return whether a function declares a primitive return type, so what it hands back is a derived value. */
function returnsPrimitive(fn: RuntimeFunction): boolean {
	const returned = fn.returnType?.typeAnnotation;
	return returned !== undefined && isPrimitiveType(returned);
}

/** Return the function a node is written in. */
function enclosingFunction(node: ESTree.Node): RuntimeFunction | null {
	for (let at: ESTree.Node | null = node.parent; at !== null; at = at.parent) if (isRuntimeFunction(at)) return at;
	return null;
}

/** Return whether every reference of a `const` or function binding is a use that `reaches` accepts. */
function everyUseReaches(variable: Variable | null | undefined, reaches: (use: Name) => boolean): boolean {
	if (variable === null || variable === undefined) return false;
	const reads = variable.references.filter((reference) => !reference.init);
	return reads.length > 0 && variable.references.every((reference) => reference.init || !reference.isWrite()) && reads.every((reference) => reaches(reference.identifier));
}

/**
 * Return whether the value an expression yields reaches nothing but the result of the probe. The value may be tested,
 * compared, negated, read further (`.identity`), pass through `Boolean(...)`, a type wrapper, a `&&`, `||`, `??` or a
 * conditional branch, be held in a `const` whose uses obey the same rule, or be returned. Only the probe ends the walk. A function that is not the
 * probe may return it when it is declared in this file and every use of it is a call whose value obeys the same rule, or when it
 * declares a primitive return type and nothing in the file refers to it (an exported sibling probe).
 * An assignment, a `delete`, an update, a call of the value, an argument to any other call, a store or a spread refuses.
 */
function resultReachesOnlyReturn(node: ESTree.Node, owner: RuntimeFunction, sourceCode: SourceCode, seen: Set<ESTree.Node>): boolean {
	if (seen.has(node)) return true;
	seen.add(node);
	const user = node.parent;
	if (user === null) return false;
	const next = (target: ESTree.Node) => resultReachesOnlyReturn(target, owner, sourceCode, seen);
	switch (user.type) {
		case "ChainExpression":
		case "TSAsExpression":
		case "TSNonNullExpression":
		case "TSSatisfiesExpression":
		case "TSTypeAssertion":
			return next(user);
		case "MemberExpression":
			return user.object === node && next(user);
		case "UnaryExpression":
			return (user.operator === "!" || user.operator === "typeof") && next(user);
		case "BinaryExpression":
			return COMPARISONS.has(user.operator) && next(user);
		case "LogicalExpression":
			return next(user);
		case "ConditionalExpression":
			return user.test === node || next(user);
		case "IfStatement":
			return user.test === node;
		case "ExpressionStatement":
			return true;
		case "CallExpression":
			return user.callee.type === "Identifier" && user.callee.name === "Boolean" && isGlobalName(user.callee, sourceCode) && user.arguments[0] === node && next(user);
		case "VariableDeclarator": {
			if (user.id.type !== "Identifier" || user.parent.type !== "VariableDeclaration" || user.parent.kind !== "const") return false;
			const local = sourceCode.getDeclaredVariables(user).find((each) => each.name === (user.id as Name).name);
			return everyUseReaches(local, next);
		}
		case "ReturnStatement":
		case "ArrowFunctionExpression": {
			if (user.type === "ArrowFunctionExpression" && user.body !== node) return false;
			const returner = user.type === "ArrowFunctionExpression" ? user : enclosingFunction(user);
			if (returner === null) return false;
			if (returner === owner) return true;
			const bound = readerVariable(returner, sourceCode);
			if (returnsPrimitive(returner) && bound !== null && bound.references.length === 0) return true;
			return everyUseReaches(bound, (use) => use.parent.type === "CallExpression" && use.parent.callee === use && next(use.parent));
		}
		default:
			return false;
	}
}

/** Return the variable a function declared in this file is bound to. */
function readerVariable(reader: RuntimeFunction, sourceCode: SourceCode): Variable | null {
	if (reader.type === "FunctionDeclaration") return reader.id === null ? null : (sourceCode.getDeclaredVariables(reader).find((variable) => variable.name === reader.id?.name && variable.defs[0]?.type === "FunctionName") ?? null);
	const declarator = reader.parent;
	if (declarator.type !== "VariableDeclarator" || declarator.init !== reader || declarator.id.type !== "Identifier") return null;
	return sourceCode.getDeclaredVariables(declarator).find((variable) => variable.name === (declarator.id as Name).name) ?? null;
}

/** What a walk of a value's uses found: whether every use is allowed, and whether some use probes a brand. */
interface Uses {
	readonly allowed: boolean;
	readonly probed: boolean;
}

const REFUSED: Uses = { allowed: false, probed: false };

function combine(uses: readonly Uses[]): Uses {
	return { allowed: uses.every((use) => use.allowed), probed: uses.some((use) => use.probed) };
}

/**
 * Walk every use of a value. A use is allowed when it is a symbol-keyed probe, an argument to a type guard declared in this
 * file, the initializer of a `const` alias whose own uses are allowed, or an argument to a function declared in this file whose
 * matching parameter's uses are allowed. Any other use (a store, a return, a call elsewhere, a cast, an assignment) refuses.
 */
function usesOf(variable: Variable, owner: RuntimeFunction, sourceCode: SourceCode, seen: Set<Variable>): Uses {
	if (seen.has(variable)) return { allowed: true, probed: false };
	seen.add(variable);
	const reads = variable.references.filter((reference) => !reference.init);
	if (variable.references.some((reference) => reference.isWrite() && !reference.init) || reads.length === 0) return REFUSED;
	return combine(
		reads.map((reference) => {
			const { identifier } = reference;
			if (isProbe(identifier, sourceCode)) return resultReachesOnlyReturn(identifier.parent, owner, sourceCode, new Set()) ? { allowed: true, probed: true } : REFUSED;
			const user = identifier.parent;
			if (user.type === "VariableDeclarator" && user.init === identifier && user.id.type === "Identifier" && user.parent.type === "VariableDeclaration" && user.parent.kind === "const") {
				const alias = sourceCode.getDeclaredVariables(user).find((each) => each.name === (user.id as Name).name);
				return alias === undefined ? REFUSED : usesOf(alias, owner, sourceCode, seen);
			}
			if (user.type !== "CallExpression") return REFUSED;
			const position = user.arguments.findIndex((argument) => argument === identifier);
			const callee = declaredFunctionOf(user.callee, sourceCode);
			if (position < 0 || callee === null) return REFUSED;
			if (guardsParameterAt(callee, position)) return { allowed: true, probed: false };
			const parameter = parameterAt(callee, position, sourceCode);
			return parameter === null ? REFUSED : usesOf(parameter, owner, sourceCode, seen);
		}),
	);
}

/**
 * Return whether a function is a brand probe on a parameter typed `unknown`: it declares a primitive return type, so the
 * value it hands back is derived, and the only things it does with the parameter are to read a symbol-keyed member that this
 * file creates (or ask `in` with one), through guards and readers declared in this file, and at least one such read happens.
 * Storing, forwarding, casting or returning the parameter, reading it by a string key, or a reader imported from elsewhere
 * is not one.
 */
export function isBrandProbe(owner: RuntimeFunction, parameter: Variable | undefined, sourceCode: SourceCode): boolean {
	const returned = owner.returnType?.typeAnnotation;
	if (parameter === undefined || returned === undefined || !isPrimitiveType(returned)) return false;
	const uses = usesOf(parameter, owner, sourceCode, new Set());
	return uses.allowed && uses.probed;
}
