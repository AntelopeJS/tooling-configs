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
function usesOf(variable: Variable, sourceCode: SourceCode, seen: Set<Variable>): Uses {
	if (seen.has(variable)) return { allowed: true, probed: false };
	seen.add(variable);
	const reads = variable.references.filter((reference) => !reference.init);
	if (variable.references.some((reference) => reference.isWrite() && !reference.init) || reads.length === 0) return REFUSED;
	return combine(
		reads.map((reference) => {
			const { identifier } = reference;
			if (isProbe(identifier, sourceCode)) return { allowed: true, probed: true };
			const user = identifier.parent;
			if (user.type === "VariableDeclarator" && user.init === identifier && user.id.type === "Identifier" && user.parent.type === "VariableDeclaration" && user.parent.kind === "const") {
				const alias = sourceCode.getDeclaredVariables(user).find((each) => each.name === (user.id as Name).name);
				return alias === undefined ? REFUSED : usesOf(alias, sourceCode, seen);
			}
			if (user.type !== "CallExpression") return REFUSED;
			const position = user.arguments.findIndex((argument) => argument === identifier);
			const callee = declaredFunctionOf(user.callee, sourceCode);
			if (position < 0 || callee === null) return REFUSED;
			if (guardsParameterAt(callee, position)) return { allowed: true, probed: false };
			const parameter = parameterAt(callee, position, sourceCode);
			return parameter === null ? REFUSED : usesOf(parameter, sourceCode, seen);
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
	const uses = usesOf(parameter, sourceCode, new Set());
	return uses.allowed && uses.probed;
}
