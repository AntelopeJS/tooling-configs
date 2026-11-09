import type { ESTree, SourceCode, Variable } from "@oxlint/plugins";

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
 * Return whether a name has no definition in this file: a name no scope binds, or a global the environment declares (`Array`,
 * `Error`), which oxlint binds to a variable with no definition.
 */
export function isGlobalName(identifier: Name, sourceCode: SourceCode): boolean {
	const variable = variableOf(identifier, sourceCode);
	return variable === null || variable.defs.length === 0;
}
