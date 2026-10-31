import type { DefinitionType, ESTree, SourceCode, Variable } from "@oxlint/plugins";

/** What a name stands for, read from its first definition. */
type Binding =
	| { readonly kind: "outside" }
	| { readonly kind: "declaration"; readonly type: DefinitionType }
	| {
			readonly kind: "variable";
			readonly variable: Variable;
			readonly initializer: ESTree.Expression | null;
			readonly constant: boolean;
	  };

/** The variables and class fields a walk has already followed, so aliases that loop back cannot loop it. */
type Seen = ReadonlySet<Variable | ESTree.PropertyDefinition>;

type Name = Extract<ESTree.Node, { type: "Identifier" }>;

const NO_VARIABLES: Seen = new Set();

/** Return the variable an identifier refers to, searching outward from its scope, or null for an unresolved global. */
export function variableOf(identifier: Name, sourceCode: SourceCode): Variable | null {
	let scope: ReturnType<SourceCode["getScope"]> | null = sourceCode.getScope(identifier);
	while (scope !== null) {
		const variable = scope.set.get(identifier.name);
		if (variable !== undefined) return variable;
		scope = scope.upper;
	}
	return null;
}

/** Classify a name: outside this file (an import, a parameter or a global), a declaration written here, or a variable with the initializer it was declared with. */
function bindingOf(identifier: Name, sourceCode: SourceCode): Binding {
	const variable = variableOf(identifier, sourceCode);
	const definition = variable?.defs[0];
	if (variable === null || definition === undefined || definition.type === "ImportBinding" || definition.type === "Parameter") {
		return { kind: "outside" };
	}
	const declarator = definition.node;
	if (declarator.type !== "VariableDeclarator" || declarator.parent.type !== "VariableDeclaration") {
		return { kind: "declaration", type: definition.type };
	}
	return { kind: "variable", variable, initializer: declarator.init, constant: declarator.parent.kind === "const" };
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
 * here, which it can hand back as a method.
 */
function isWrittenHere(node: ESTree.Node, sourceCode: SourceCode, seen: Seen): boolean {
	const inner = passThrough(node);
	if (inner !== null) return isWrittenHere(inner, sourceCode, seen);
	switch (node.type) {
		case "Identifier": {
			const binding = bindingOf(node, sourceCode);
			if (binding.kind === "outside") return false;
			if (binding.kind === "declaration") return true;
			const { initializer, constant, variable } = binding;
			return !constant || initializer === null || seen.has(variable) || isWrittenHere(initializer, sourceCode, new Set([...seen, variable]));
		}
		case "ImportExpression":
			return false;
		case "MemberExpression":
			return node.object.type === "ThisExpression"
				? thisFieldIsWrittenHere(node, sourceCode, seen)
				: isWrittenHere(node.object, sourceCode, seen);
		case "CallExpression":
		case "NewExpression":
			return isWrittenHere(node.callee, sourceCode, seen) || node.arguments.some((argument) => holdsFunctionHere(argument, sourceCode, seen));
		case "ConditionalExpression":
			return isWrittenHere(node.consequent, sourceCode, seen) || isWrittenHere(node.alternate, sourceCode, seen);
		case "LogicalExpression":
			return isWrittenHere(node.left, sourceCode, seen) || isWrittenHere(node.right, sourceCode, seen);
		default:
			return true;
	}
}

/** Return the name a class element or member is written with, or null for a computed one. */
function staticName(key: ESTree.Node, computed: boolean): string | null {
	return !computed && (key.type === "Identifier" || key.type === "PrivateIdentifier") ? key.name : null;
}

/** Return the class a node is written in, or null at the top level. */
function enclosingClass(node: ESTree.Node): ESTree.Class | null {
	let current: ESTree.Node | null = node.parent;
	while (current !== null && current.type !== "ClassDeclaration" && current.type !== "ClassExpression") current = current.parent;
	return current;
}

/**
 * Return whether `this.field` reaches back to code written here. A field with an initializer is read through
 * it. A constructor parameter property is handed in by the caller, as a parameter is. A field declared without
 * an initializer, one inherited, a getter and a computed name are not placed, so they count as written here.
 */
function thisFieldIsWrittenHere(member: ESTree.MemberExpression, sourceCode: SourceCode, seen: Seen): boolean {
	const klass = enclosingClass(member);
	const name = staticName(member.property, member.computed);
	if (klass === null || name === null) return true;
	for (const element of klass.body.body) {
		if (element.type === "PropertyDefinition" && staticName(element.key, element.computed) === name) {
			return element.value === null || seen.has(element) || isWrittenHere(element.value, sourceCode, new Set([...seen, element]));
		}
		if (element.type === "MethodDefinition") {
			const handedIn = element.value.params.some(
				(parameter) =>
					parameter.type === "TSParameterProperty" &&
					parameter.parameter.type === "Identifier" &&
					parameter.parameter.name === name,
			);
			if (handedIn) return false;
		}
	}
	return true;
}

/** Return whether a value is a function or class written here, an object of such members, or a member or call that reaches back to this file. */
function isFunctionHere(node: ESTree.Node, sourceCode: SourceCode, seen: Seen): boolean {
	const inner = passThrough(node);
	if (inner !== null) return isFunctionHere(inner, sourceCode, seen);
	switch (node.type) {
		case "FunctionExpression":
		case "ArrowFunctionExpression":
		case "ClassExpression":
			return true;
		case "ObjectExpression":
			return holdsFunctionHere(node, sourceCode, seen);
		case "Identifier": {
			const binding = bindingOf(node, sourceCode);
			if (binding.kind === "declaration") return binding.type === "FunctionName" || binding.type === "ClassName";
			return binding.kind === "variable" && followInitializer(binding, sourceCode, seen, isFunctionHere);
		}
		case "MemberExpression":
		case "CallExpression":
		case "NewExpression":
			return isWrittenHere(node, sourceCode, seen);
		default:
			return false;
	}
}

/** Return whether an argument is an object, or a class, whose members include a function written here. A function handed over on its own is not: a schema may take a local refinement. */
function holdsFunctionHere(node: ESTree.Node, sourceCode: SourceCode, seen: Seen): boolean {
	const inner = passThrough(node);
	if (inner !== null) return holdsFunctionHere(inner, sourceCode, seen);
	switch (node.type) {
		case "ClassExpression":
			return true;
		case "ObjectExpression":
			return node.properties.some((property) =>
				property.type === "SpreadElement"
					? holdsFunctionHere(property.argument, sourceCode, seen)
					: isFunctionHere(property.value, sourceCode, seen),
			);
		case "Identifier": {
			const binding = bindingOf(node, sourceCode);
			if (binding.kind === "declaration") return binding.type === "ClassName";
			return binding.kind === "variable" && followInitializer(binding, sourceCode, seen, holdsFunctionHere);
		}
		case "MemberExpression":
		case "CallExpression":
		case "NewExpression":
		case "ConditionalExpression":
		case "LogicalExpression":
			return isWrittenHere(node, sourceCode, seen);
		default:
			return false;
	}
}

/** Apply a test to the initializer of a variable, once per variable on the path, and answer false for a variable with none. */
function followInitializer(
	binding: Extract<Binding, { kind: "variable" }>,
	sourceCode: SourceCode,
	seen: Seen,
	test: (node: ESTree.Node, sourceCode: SourceCode, seen: Seen) => boolean,
): boolean {
	const { initializer, variable } = binding;
	return initializer !== null && !seen.has(variable) && test(initializer, sourceCode, new Set([...seen, variable]));
}

/**
 * Return whether a call goes to code written in this file. A bare callee counts when any declaration in the file
 * binds it, a parameter included. A member callee counts when the value it is read from reaches back to this
 * file, so a member of a parameter, which the caller supplies, does not.
 */
export function calleeIsWrittenHere(call: ESTree.CallExpression, sourceCode: SourceCode): boolean {
	const { callee } = call;
	if (callee.type === "Identifier") {
		const definition = variableOf(callee, sourceCode)?.defs[0];
		return definition !== undefined && definition.type !== "ImportBinding";
	}
	return callee.type === "MemberExpression" && isWrittenHere(callee.object, sourceCode, NO_VARIABLES);
}
