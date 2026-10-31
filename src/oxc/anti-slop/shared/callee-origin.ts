import type { DefinitionType, ESTree, SourceCode, Variable } from "@oxlint/plugins";

import { isSuppliedFromOutside, mayBeMergedMember, variableOf } from "./binding-origin.ts";

/**
 * What a name stands for. `unplaced` is a name no scope binds that the file may still declare or write, as a merged namespace
 * member or an assigned global, so it is never outside. Its value comes from the expressions the file writes to it (its initializer, a default, an
 * assignment) and the name an `import x = Namespace.member` reads, plus a caller or module when it is a parameter or import.
 * `constant` is false when some write has no expression to follow, or a definition is not a `const` with an initializer.
 */
type Binding =
	| { readonly kind: "outside" }
	| { readonly kind: "unplaced" }
	| { readonly kind: "declaration"; readonly type: DefinitionType }
	| {
			readonly kind: "variable";
			readonly variable: Variable;
			readonly sources: readonly ESTree.Node[];
			readonly constant: boolean;
	  };

/** The variables and class fields a walk has already followed, so aliases that loop back cannot loop it. */
type Seen = ReadonlySet<Variable | ESTree.PropertyDefinition>;

type Name = Extract<ESTree.Node, { type: "Identifier" }>;

const NO_VARIABLES: Seen = new Set();

/** Return the name an `import x = Outer.Inner.member` reads first, the one the file must declare. */
function entityRoot(name: ESTree.TSTypeName): ESTree.Node {
	return name.type === "TSQualifiedName" ? entityRoot(name.left) : name;
}

/** Return the name an `import x = Namespace.member` reads, or null for a module import, which another file gives a value. */
function aliasRoot(definition: Variable["defs"][number]): ESTree.Node | null {
	const { node } = definition;
	if (node.type !== "TSImportEqualsDeclaration") return null;
	return node.moduleReference.type === "TSExternalModuleReference" ? null : entityRoot(node.moduleReference);
}

/** Return whether a definition is a `const` with an initializer, a parameter or an import, so that nothing but a write reference changes its value. */
function isFixedDefinition(definition: Variable["defs"][number]): boolean {
	const { node } = definition;
	return definition.type !== "Variable" || (node.type === "VariableDeclarator" && node.init !== null && node.parent.type === "VariableDeclaration" && node.parent.kind === "const");
}

/**
 * Classify a name by every definition and write it has, not by its first definition. It is outside this file only when
 * `isSuppliedFromOutside` places it there. A name no scope binds, or that a merged namespace member may shadow, is unplaced.
 * A function, class, namespace or catch binding is a declaration written here. Any other name is a variable read through the
 * expressions written to it.
 */
function bindingOf(identifier: Name, sourceCode: SourceCode): Binding {
	if (isSuppliedFromOutside(identifier, sourceCode)) return { kind: "outside" };
	const variable = variableOf(identifier, sourceCode);
	if (variable === null || mayBeMergedMember(identifier, variable)) return { kind: "unplaced" };
	const declared = variable.defs.find((definition) => !["Variable", "Parameter", "ImportBinding"].includes(definition.type));
	if (declared !== undefined) return { kind: "declaration", type: declared.type };
	const writes = variable.references.filter((reference) => reference.isWrite());
	const sources = [...variable.defs.map(aliasRoot), ...writes.map((write) => write.writeExpr)].filter((source) => source !== null);
	const constant = variable.defs.every(isFixedDefinition) && writes.every((write) => write.writeExpr !== null);
	return { kind: "variable", variable, sources, constant };
}

/** Return the expression a type wrapper, an `await` or an optional chain only passes through, or null when the node is none of these. */
function passThrough(node: ESTree.Node): ESTree.Node | null {
	switch (node.type) {
		case "TSAsExpression":
		case "TSSatisfiesExpression":
		case "TSNonNullExpression":
		case "TSTypeAssertion":
		case "ChainExpression":
			return node.expression;
		case "AwaitExpression":
			return node.argument;
		default:
			return null;
	}
}

/**
 * Return whether a value reaches back to code written in this file: walk through members, calls, `new`, type
 * wrappers and `const` aliases to the name or literal at the root. An import, a parameter and a global are
 * outside the file. A function, class, namespace, `let`, `var`, `this`, `super`, object literal or anything this
 * walk cannot place is inside it. A call also counts when it is handed an object that holds a function written
 * here, which it can hand back as a method. A call rooted at a global (`Object.freeze`, `Array.from`, `Promise.resolve`) is
 * no factory that wraps a schema, so a function handed to it counts too, as a callback it can call.
 */
function isWrittenHere(node: ESTree.Node, sourceCode: SourceCode, seen: Seen): boolean {
	const inner = passThrough(node);
	if (inner !== null) return isWrittenHere(inner, sourceCode, seen);
	switch (node.type) {
		case "Identifier": {
			const binding = bindingOf(node, sourceCode);
			if (binding.kind === "outside") return false;
			if (binding.kind !== "variable") return true;
			return !binding.constant || seen.has(binding.variable) || followSources(binding, sourceCode, seen, isWrittenHere);
		}
		case "ImportExpression":
			return false;
		case "MemberExpression":
			return node.object.type === "ThisExpression"
				? thisFieldIsWrittenHere(node, sourceCode, seen)
				: isWrittenHere(node.object, sourceCode, seen);
		case "CallExpression":
		case "NewExpression": {
			const handsOver = isRootedAtGlobal(node.callee, sourceCode) ? isFunctionHere : holdsFunctionHere;
			return isWrittenHere(node.callee, sourceCode, seen) || node.arguments.some((argument) => handsOver(argument, sourceCode, seen));
		}
		case "ConditionalExpression":
			return isWrittenHere(node.consequent, sourceCode, seen) || isWrittenHere(node.alternate, sourceCode, seen);
		case "LogicalExpression":
			return isWrittenHere(node.left, sourceCode, seen) || isWrittenHere(node.right, sourceCode, seen);
		default:
			return true;
	}
}

/** Return whether a callee is read from a global no scope binds, through members, calls and type wrappers. */
function isRootedAtGlobal(node: ESTree.Node, sourceCode: SourceCode): boolean {
	const inner = passThrough(node);
	if (inner !== null) return isRootedAtGlobal(inner, sourceCode);
	switch (node.type) {
		case "Identifier":
			return variableOf(node, sourceCode) === null;
		case "MemberExpression":
			return isRootedAtGlobal(node.object, sourceCode);
		case "CallExpression":
		case "NewExpression":
			return isRootedAtGlobal(node.callee, sourceCode);
		default:
			return false;
	}
}

/** Return whether a node is a primitive value, which holds no function: a literal, a template, or the result of a unary, binary or update operator. */
function isPrimitive(node: ESTree.Node): boolean {
	switch (node.type) {
		case "Literal":
		case "TemplateLiteral":
		case "UnaryExpression":
		case "BinaryExpression":
		case "UpdateExpression":
			return true;
		default:
			return false;
	}
}

/** Return the name a class element or member is read by, or null for a computed one. A private name carries its `#`, so it is no element of the public name. */
function elementName(key: ESTree.Node, computed: boolean): string | null {
	if (computed) return null;
	if (key.type === "PrivateIdentifier") return `#${key.name}`;
	return key.type === "Identifier" ? key.name : null;
}

/** Return the class a node is written in, or null at the top level. */
function enclosingClass(node: ESTree.Node): ESTree.Class | null {
	let current: ESTree.Node | null = node.parent;
	while (current !== null && current.type !== "ClassDeclaration" && current.type !== "ClassExpression") current = current.parent;
	return current;
}

/**
 * Return what `this` is where a node is written: the instance or the class itself when the nearest non-arrow function is a
 * class method, or when no function sits between the node and a field initializer or static block. Any other function (an
 * object-literal method, a function expression, a declaration) gets its `this` from its caller, as does a node in a class
 * heritage clause, a decorator or a computed key, which the walk meets as the class itself. Those give null.
 */
function receiverOf(node: ESTree.Node): "instance" | "static" | null {
	let child: ESTree.Node = node;
	for (let current: ESTree.Node | null = node.parent; current !== null; current = current.parent) {
		switch (current.type) {
			case "FunctionExpression":
				return current.parent.type === "MethodDefinition" && current.parent.value === current ? (current.parent.static ? "static" : "instance") : null;
			case "PropertyDefinition":
			case "AccessorProperty":
				return current.value === child ? (current.static ? "static" : "instance") : null;
			case "StaticBlock":
				return "static";
			case "FunctionDeclaration":
			case "ClassDeclaration":
			case "ClassExpression":
				return null;
			default:
				child = current;
		}
	}
	return null;
}

/**
 * Return whether `this.field` reaches back to code written here. The element is the one of that exact name, `#` included, and of
 * the receiver's kind, static or instance. A field with an initializer is read through it. A constructor parameter property is
 * an instance element handed in by the caller, as a parameter is. A name that no element or two elements declare, an
 * accessor, a method, a field without an initializer, an inherited field and a computed name are not placed, so they count as
 * written here.
 */
function thisFieldIsWrittenHere(member: ESTree.MemberExpression, sourceCode: SourceCode, seen: Seen): boolean {
	const klass = enclosingClass(member);
	const name = elementName(member.property, member.computed);
	const receiver = receiverOf(member);
	if (klass === null || name === null || receiver === null) return true;
	const elements = klass.body.body.filter(
		(element) =>
			(element.type === "PropertyDefinition" || element.type === "AccessorProperty" || element.type === "MethodDefinition") &&
			element.static === (receiver === "static") &&
			elementName(element.key, element.computed) === name,
	);
	const handedIn = receiver === "instance" && klass.body.body.some((element) => element.type === "MethodDefinition" && declaresParameterProperty(element, name));
	if (elements.length + (handedIn ? 1 : 0) !== 1) return true;
	const [element] = elements;
	if (element === undefined) return false;
	if (element.type !== "PropertyDefinition") return true;
	return element.value === null || seen.has(element) || isWrittenHere(element.value, sourceCode, new Set([...seen, element]));
}

/** Return whether a method declares a parameter property of this name, which only a constructor can. */
function declaresParameterProperty(method: ESTree.MethodDefinition, name: string): boolean {
	return method.value.params.some(
		(parameter) => parameter.type === "TSParameterProperty" && parameter.parameter.type === "Identifier" && parameter.parameter.name === name,
	);
}

/**
 * Return whether a value is local code: a function or class written here, an object or array of such members, or a member or call
 * that reaches back to this file. Only a primitive, an import, a parameter and an object of such values are not, so a node this
 * walk does not list, a function, a class and any syntax added later included, is reported.
 */
function isFunctionHere(node: ESTree.Node, sourceCode: SourceCode, seen: Seen): boolean {
	const inner = passThrough(node);
	if (inner !== null) return isFunctionHere(inner, sourceCode, seen);
	switch (node.type) {
		case "ObjectExpression":
		case "ArrayExpression":
			return holdsFunctionHere(node, sourceCode, seen);
		case "ConditionalExpression":
			return isFunctionHere(node.consequent, sourceCode, seen) || isFunctionHere(node.alternate, sourceCode, seen);
		case "LogicalExpression":
			return isFunctionHere(node.left, sourceCode, seen) || isFunctionHere(node.right, sourceCode, seen);
		case "Identifier": {
			const binding = bindingOf(node, sourceCode);
			if (binding.kind === "unplaced") return true;
			if (binding.kind === "declaration") return binding.type === "FunctionName" || binding.type === "ClassName";
			return binding.kind === "variable" && followSources(binding, sourceCode, seen, isFunctionHere);
		}
		case "MemberExpression":
		case "CallExpression":
		case "NewExpression":
			return isWrittenHere(node, sourceCode, seen);
		default:
			return !isPrimitive(node);
	}
}

/**
 * Return whether an argument is an object, an array or a class whose members include a function written here, or a `this`.
 * A function handed over on its own is not: a schema may take a local refinement. A node this walk does not list is reported
 * unless it is a primitive.
 */
function holdsFunctionHere(node: ESTree.Node, sourceCode: SourceCode, seen: Seen): boolean {
	const inner = passThrough(node);
	if (inner !== null) return holdsFunctionHere(inner, sourceCode, seen);
	switch (node.type) {
		case "FunctionExpression":
		case "ArrowFunctionExpression":
			return false;
		case "SpreadElement":
			return holdsFunctionHere(node.argument, sourceCode, seen);
		case "ObjectExpression":
			return node.properties.some((property) =>
				property.type === "SpreadElement"
					? holdsFunctionHere(property.argument, sourceCode, seen)
					: isFunctionHere(property.value, sourceCode, seen),
			);
		case "ArrayExpression":
			return node.elements.some((element) => element !== null && (element.type === "SpreadElement" ? holdsFunctionHere(element.argument, sourceCode, seen) : isFunctionHere(element, sourceCode, seen)));
		case "Identifier": {
			const binding = bindingOf(node, sourceCode);
			if (binding.kind === "unplaced") return true;
			if (binding.kind === "declaration") return binding.type === "ClassName";
			return binding.kind === "variable" && followSources(binding, sourceCode, seen, holdsFunctionHere);
		}
		case "MemberExpression":
		case "CallExpression":
		case "NewExpression":
		case "ConditionalExpression":
		case "LogicalExpression":
			return isWrittenHere(node, sourceCode, seen);
		default:
			return !isPrimitive(node);
	}
}

/** Apply a test to each expression written to a variable, once per variable on the path, and answer false for a variable written nothing. */
function followSources(
	binding: Extract<Binding, { kind: "variable" }>,
	sourceCode: SourceCode,
	seen: Seen,
	test: (node: ESTree.Node, sourceCode: SourceCode, seen: Seen) => boolean,
): boolean {
	const { sources, variable } = binding;
	return !seen.has(variable) && sources.some((source) => test(source, sourceCode, new Set([...seen, variable])));
}

/**
 * Return whether a call goes to code written in this file. A bare callee counts when it is not outside the file, as
 * `isSuppliedFromOutside` decides, or when it is a parameter. A member callee counts when the value it is read from reaches back
 * to this file, so a member of a parameter, which the caller supplies, does not.
 */
export function calleeIsWrittenHere(call: ESTree.CallExpression, sourceCode: SourceCode): boolean {
	const { callee } = call;
	if (callee.type === "Identifier") {
		const variable = variableOf(callee, sourceCode);
		return !isSuppliedFromOutside(callee, sourceCode) || (variable !== null && variable.defs.some((definition) => definition.type === "Parameter"));
	}
	return callee.type === "MemberExpression" && isWrittenHere(callee.object, sourceCode, NO_VARIABLES);
}
