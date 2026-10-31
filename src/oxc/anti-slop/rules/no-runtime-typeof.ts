import { defineRule } from "@oxlint/plugins";

import type { ESTree, SourceCode } from "@oxlint/plugins";

import { isSuppliedFromOutside } from "../shared/binding-origin.ts";
import { enclosingTypeGuard } from "../shared/type-guards.ts";

/** Return whether typeof safely probes for the existence of a possibly absent binding. */
function isExistenceProbe(node: ESTree.UnaryExpression): boolean {
	const parent = node.parent;
	if (parent.type !== "BinaryExpression") return false;
	if (!["===", "!==", "==", "!="].includes(parent.operator)) return false;
	const other = parent.left === node ? parent.right : parent.left;
	return other.type === "Literal" && other.value === "undefined";
}

/** Return the name a callee is read from, through members and type wrappers, or null when it is read from `this`, a call or anything else. */
function rootOf(node: ESTree.Node): Extract<ESTree.Node, { type: "Identifier" }> | null {
	switch (node.type) {
		case "Identifier":
			return node;
		case "MemberExpression":
			return rootOf(node.object);
		case "TSNonNullExpression":
		case "TSAsExpression":
		case "TSSatisfiesExpression":
		case "TSTypeAssertion":
			return rootOf(node.expression);
		default:
			return null;
	}
}

/** Return whether a callee is read from a name that takes its value from outside this file, through members and type wrappers. */
function isReadFromOutside(callee: ESTree.Node, sourceCode: SourceCode): boolean {
	const root = rootOf(callee);
	return root !== null && isSuppliedFromOutside(root, sourceCode);
}

/**
 * Return whether a callee only raises or records the message it is given: a bare `assert(...)`, or the `log` method of any object,
 * when its root is a module import, a global or a parameter. A root written in this file (a function, a class, a `const`, `this`, a
 * parameter this file defaults or assigns) can compare or store the message, so it is no sink. A call to any other name can too
 * (`assert.equal`, `Set#add`, `emit`).
 */
function isMessageSink(callee: ESTree.CallExpression["callee"], sourceCode: SourceCode): boolean {
	if (!isReadFromOutside(callee, sourceCode)) return false;
	if (callee.type === "Identifier") return callee.name === "assert";
	return (
		callee.type === "MemberExpression" &&
		!callee.computed &&
		callee.property.type === "Identifier" &&
		callee.property.name === "log"
	);
}

/**
 * Return whether a message ends at this parent: it is thrown, handed to the `assert` or `log` call that stands as a statement,
 * or handed to the `new` a `throw` throws when its class is read from outside this file, as `Error` is. Any other call, and a text a function returns, can be tested or used as a key by
 * whatever receives it, so they are not message sinks.
 */
function endsMessage(parent: ESTree.Node, sourceCode: SourceCode): boolean {
	switch (parent.type) {
		case "ThrowStatement":
			return true;
		case "CallExpression":
			return parent.parent.type === "ExpressionStatement" && isMessageSink(parent.callee, sourceCode);
		case "NewExpression":
			return parent.parent.type === "ThrowStatement" && isReadFromOutside(parent.callee, sourceCode);
		default:
			return false;
	}
}

/**
 * Return whether a `typeof` only fills in the text of a message that a `throw`, an `assert` or a `log` call, or the `new` under a `throw` takes.
 * Such a template holds other text, so no comparison with a `typeof` result matches it, and TypeScript narrows nothing from it.
 */
function isMessageText(node: ESTree.UnaryExpression, sourceCode: SourceCode): boolean {
	let current: ESTree.Node = node.parent;
	if (current.type !== "TemplateLiteral" || current.quasis.every((quasi) => quasi.value.raw === "")) return false;
	while (
		current.parent.type === "TemplateLiteral" ||
		(current.parent.type === "ConditionalExpression" && current.parent.test !== current)
	) {
		current = current.parent;
	}
	return endsMessage(current.parent, sourceCode);
}

/** Built-ins whose `.constructor` comparison re-implements a `typeof` result. */
const TYPEOF_CONSTRUCTORS = new Set(["String", "Number", "Boolean", "BigInt", "Symbol", "Function"]);

/** Return the built-in name when the comparison is `x.constructor === String` or its mirror. */
function constructorCheckTarget(node: ESTree.BinaryExpression): string | undefined {
	if (!["===", "!==", "==", "!="].includes(node.operator)) return undefined;
	for (const [operand, other] of [
		[node.left, node.right],
		[node.right, node.left],
	]) {
		const side = operand.type === "ChainExpression" ? operand.expression : operand;
		if (
			side.type === "MemberExpression" &&
			!side.computed &&
			side.property.type === "Identifier" &&
			side.property.name === "constructor" &&
			other.type === "Identifier" &&
			TYPEOF_CONSTRUCTORS.has(other.name)
		) {
			return other.name;
		}
	}
	return undefined;
}

/** Disallow runtime typeof checks that narrow unparsed values instead of decoding them. */
export const noRuntimeTypeofRule = defineRule({
	meta: {
		type: "problem",
		docs: {
			description:
				"Disallow runtime typeof checks; external values must be decoded into meaningful types at their I/O boundary. A `typeof` that only fills in the text of a message checks nothing.",
		},
		messages: {
			runtimeTypeof:
				"A `typeof` check narrows a representation without establishing its contract. Parse input at its I/O boundary, then branch on the domain value.",
			constructorCheck:
				"`.constructor === {{name}}` is a `typeof` check in another form. Parse input at its I/O boundary, or move the check into a type guard such as `(value: unknown): value is string`.",
		},
		schema: [
			{
				type: "object",
				properties: {
					allowInTypeGuards: { type: "boolean" },
				},
				additionalProperties: false,
			},
		],
		defaultOptions: [{ allowInTypeGuards: false }],
	},
	createOnce(context) {
		function allowedInTypeGuard(node: ESTree.Node): boolean {
			const option = context.options?.[0];
			return (
				typeof option === "object" &&
				option !== null &&
				!Array.isArray(option) &&
				option.allowInTypeGuards === true &&
				enclosingTypeGuard(node, context.sourceCode, context.filename) !== null
			);
		}
		return {
			UnaryExpression(node) {
				if (node.operator === "typeof" && !isExistenceProbe(node) && !isMessageText(node, context.sourceCode) && !allowedInTypeGuard(node)) {
					context.report({ node, messageId: "runtimeTypeof" });
				}
			},
			BinaryExpression(node) {
				const name = constructorCheckTarget(node);
				if (name !== undefined && !allowedInTypeGuard(node)) {
					context.report({ node, messageId: "constructorCheck", data: { name } });
				}
			},
		};
	},
});
