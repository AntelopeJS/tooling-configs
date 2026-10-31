import type { DefinitionType, ESTree, SourceCode, Variable } from "@oxlint/plugins";

import { isModuleImport, isSuppliedFromOutside, variableOf } from "./binding-origin.ts";

/**
 * What a name stands for. Its value comes from the expressions the file writes to it (its initializer, a default, an
 * assignment, the target of an `import x = Namespace.member`), plus a caller or module when it is a parameter or import.
 * `constant` is false when some write has no expression to follow, or the declaration is not a `const` with an initializer.
 */
type Binding =
	| { readonly kind: "outside" }
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

/** Return the expression a definition gives its name, or null when it gives none: a parameter, a module import, a loop variable. */
function definitionSource(definition: Variable["defs"][number]): ESTree.Node | null {
	const { node } = definition;
	if (definition.type === "ImportBinding") {
		if (node.type !== "TSImportEqualsDeclaration") return null;
		return node.moduleReference.type === "TSExternalModuleReference" ? null : entityRoot(node.moduleReference);
	}
	return definition.type === "Variable" && node.type === "VariableDeclarator" ? node.init : null;
}

/** Return whether a definition is a `const` with an initializer, a parameter or an import, so that nothing but a write reference changes its value. */
function isFixedDefinition(definition: Variable["defs"][number]): boolean {
	const { node } = definition;
	if (definition.type !== "Variable") return true;
	return node.type === "VariableDeclarator" && node.init !== null && node.parent.type === "VariableDeclaration" && node.parent.kind === "const";
}

/**
 * Classify a name by every definition and write it has, not by its first definition. It is outside this file when
 * nothing here gives it a value. A function, class, namespace or catch binding is a declaration written here. Any other name is
 * a variable read through the expressions written to it.
 */
function bindingOf(identifier: Name, sourceCode: SourceCode): Binding {
	const variable = variableOf(identifier, sourceCode);
	if (variable === null || isSuppliedFromOutside(variable)) return { kind: "outside" };
	const declared = variable.defs.find((definition) => !["Variable", "Parameter", "ImportBinding"].includes(definition.type));
	if (declared !== undefined) return { kind: "declaration", type: declared.type };
	const writes = variable.references.filter((reference) => reference.isWrite());
	const sources = [...variable.defs.map(definitionSource), ...writes.map((write) => write.writeExpr)].filter((source) => source !== null);
	const constant = variable.defs.every(isFixedDefinition) && writes.every((write) => write.writeExpr !== null) && sources.length > 0;
	return { kind: "variable", variable, sources: [...new Set(sources)], constant };
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
			return !binding.constant || seen.has(binding.variable) || followSources(binding, sourceCode, seen, isWrittenHere);
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

/** Return whether `this` in a node is the class itself: the node is written in a static member or a static block. */
function isStaticContext(node: ESTree.Node): boolean {
	let current: ESTree.Node | null = node.parent;
	while (current !== null) {
		if (current.type === "StaticBlock") return true;
		if (current.type === "MethodDefinition" || current.type === "PropertyDefinition" || current.type === "AccessorProperty") return current.static;
		current = current.parent;
	}
	return false;
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
		if (element.type === "PropertyDefinition" && element.static === isStaticContext(member) && staticName(element.key, element.computed) === name) {
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
			return binding.kind === "variable" && followSources(binding, sourceCode, seen, isFunctionHere);
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
			return binding.kind === "variable" && followSources(binding, sourceCode, seen, holdsFunctionHere);
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
 * Return whether a call goes to code written in this file. A bare callee counts when any declaration in the file
 * binds it, a parameter and an `import x = Namespace.member` included, and only a module import is outside. A member callee counts when the value it is read from reaches back to this
 * file, so a member of a parameter, which the caller supplies, does not.
 */
export function calleeIsWrittenHere(call: ESTree.CallExpression, sourceCode: SourceCode): boolean {
	const { callee } = call;
	if (callee.type === "Identifier") {
		return variableOf(callee, sourceCode)?.defs.some((definition) => !isModuleImport(definition)) ?? false;
	}
	return callee.type === "MemberExpression" && isWrittenHere(callee.object, sourceCode, NO_VARIABLES);
}
