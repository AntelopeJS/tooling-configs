import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

import { enclosingTypeGuard } from "../shared/type-guards.ts";

/** Return whether typeof safely probes for the existence of a possibly absent binding. */
function isExistenceProbe(node: ESTree.UnaryExpression): boolean {
	const parent = node.parent;
	if (parent.type !== "BinaryExpression") return false;
	if (!["===", "!==", "==", "!="].includes(parent.operator)) return false;
	const other = parent.left === node ? parent.right : parent.left;
	return other.type === "Literal" && other.value === "undefined";
}

/**
 * Return whether a callee only raises or records the message it is given: a bare `assert(...)`, or the `log` method of any object.
 * A call to any other name can compare, store or route on its arguments (`assert.equal`, `Set#add`, `emit`), so it is no sink.
 */
function isMessageSink(callee: ESTree.CallExpression["callee"]): boolean {
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
 * or handed to the `new` a `throw` throws. Any other call, and a text a function returns, can be tested or used as a key by
 * whatever receives it, so they are not message sinks.
 */
function endsMessage(parent: ESTree.Node): boolean {
	switch (parent.type) {
		case "ThrowStatement":
			return true;
		case "CallExpression":
			return parent.parent.type === "ExpressionStatement" && isMessageSink(parent.callee);
		case "NewExpression":
			return parent.parent.type === "ThrowStatement";
		default:
			return false;
	}
}

/**
 * Return whether a `typeof` only fills in the text of a message that a `throw`, an `assert` or a `log` call, or the `new` under a `throw` takes.
 * Such a template holds other text, so no comparison with a `typeof` result matches it, and TypeScript narrows nothing from it.
 */
function isMessageText(node: ESTree.UnaryExpression): boolean {
	let current: ESTree.Node = node.parent;
	if (current.type !== "TemplateLiteral" || current.quasis.every((quasi) => quasi.value.raw === "")) return false;
	while (
		current.parent.type === "TemplateLiteral" ||
		(current.parent.type === "ConditionalExpression" && current.parent.test !== current)
	) {
		current = current.parent;
	}
	return endsMessage(current.parent);
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
				if (node.operator === "typeof" && !isExistenceProbe(node) && !isMessageText(node) && !allowedInTypeGuard(node)) {
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
