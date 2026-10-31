import type { ESTree, SourceCode, Variable } from "@oxlint/plugins";

type Definition = Variable["defs"][number];

type Name = Extract<ESTree.Node, { type: "Identifier" }>;

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

/**
 * Return whether a definition takes its value from another module: an `import` declaration, or `import x = require()`.
 * An `import x = Namespace.member` only renames a name, so its value comes from where that name is declared.
 */
export function isModuleImport(definition: Definition): boolean {
	if (definition.type !== "ImportBinding") return false;
	const { node } = definition;
	return node.type !== "TSImportEqualsDeclaration" || node.moduleReference.type === "TSExternalModuleReference";
}

/**
 * Return whether a name no scope binds is a global that nothing in this file merges or writes. TypeScript merges the blocks of
 * one namespace, and the scope manager does not, so a name read inside a namespace may be a member of another block. A write
 * to the name anywhere in the file, including to one a `declare global` introduces, gives it a value written here.
 */
function isUnwrittenGlobal(identifier: Name, sourceCode: SourceCode): boolean {
	for (let node: ESTree.Node | null = identifier.parent; node !== null; node = node.parent) {
		if (node.type === "TSModuleBlock") return false;
	}
	const scope = sourceCode.scopeManager.globalScope;
	return scope !== null && !scope.through.some((reference) => reference.identifier.name === identifier.name && reference.isWrite());
}

/**
 * Return whether a name takes its value from outside this file, which only a binding or reference the code can place proves:
 * a module import, or a parameter, that nothing here defaults, assigns or redeclares, or a global that nothing here merges or
 * writes. The kind of the first definition does not say it: a default, an assignment and a later `var` give a parameter a value
 * written here, and an `import x = Namespace.member` is no module import. Any other name is not outside.
 */
export function isSuppliedFromOutside(identifier: Name, sourceCode: SourceCode): boolean {
	const variable = variableOf(identifier, sourceCode);
	if (variable === null) return isUnwrittenGlobal(identifier, sourceCode);
	return (
		variable.defs.every((definition) => definition.type === "Parameter" || isModuleImport(definition)) &&
		variable.references.every((reference) => !reference.isWrite())
	);
}
