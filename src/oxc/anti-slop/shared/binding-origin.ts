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
function isModuleImport(definition: Definition): boolean {
	if (definition.type !== "ImportBinding") return false;
	const { node } = definition;
	return node.type !== "TSImportEqualsDeclaration" || node.moduleReference.type === "TSExternalModuleReference";
}

/**
 * Return whether a name has no definition in this file: a name no scope binds, or a global the environment declares (`Array`,
 * `Error`), which oxlint binds to a variable with no definition.
 */
export function isGlobalName(identifier: Name, sourceCode: SourceCode): boolean {
	const variable = variableOf(identifier, sourceCode);
	return variable === null || variable.defs.length === 0;
}

/** Return whether a node sits inside another, or is it. */
function isWithin(node: ESTree.Node, ancestor: ESTree.Node): boolean {
	for (let at: ESTree.Node | null = node; at !== null; at = at.parent) if (at === ancestor) return true;
	return false;
}

/**
 * Return whether a name read inside a namespace block may be a member that another block of the same namespace declares.
 * TypeScript merges the blocks of one namespace, and the scope manager does not, so a name that has no definition in the file
 * (see `isGlobalName`), or whose definitions sit outside the block, may resolve to such a member and not to the binding the
 * scope manager found.
 */
export function mayBeMergedMember(identifier: Name, variable: Variable | null): boolean {
	for (let node: ESTree.Node | null = identifier.parent; node !== null; node = node.parent) {
		if (node.type !== "TSModuleBlock") continue;
		const block = node;
		return variable === null || variable.defs.length === 0 || !variable.defs.every((definition) => isWithin(definition.node, block));
	}
	return false;
}

/**
 * Return whether a name no scope binds is a global that nothing in this file writes, including a global that a `declare global`
 * introduces.
 */
function isUnwrittenGlobal(identifier: Name, sourceCode: SourceCode): boolean {
	const scope = sourceCode.scopeManager.globalScope;
	return scope !== null && !scope.through.some((reference) => reference.identifier.name === identifier.name && reference.isWrite());
}

/**
 * Return whether a name takes its value from outside this file, which only a binding or reference the code can place proves:
 * a module import, or a parameter, that nothing here defaults, assigns or redeclares, or a global that nothing here writes,
 * and that no block of a namespace may shadow with a merged member. The kind of the first definition does not say it: a
 * default, an assignment and a later `var` give a parameter a value written here, and an `import x = Namespace.member` is no
 * module import. Any other name is not outside.
 */
export function isSuppliedFromOutside(identifier: Name, sourceCode: SourceCode): boolean {
	const variable = variableOf(identifier, sourceCode);
	if (mayBeMergedMember(identifier, variable)) return false;
	if (variable === null) return isUnwrittenGlobal(identifier, sourceCode);
	return (
		variable.defs.every((definition) => definition.type === "Parameter" || isModuleImport(definition)) &&
		variable.references.every((reference) => !reference.isWrite())
	);
}
