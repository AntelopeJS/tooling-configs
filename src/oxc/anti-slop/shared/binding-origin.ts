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
