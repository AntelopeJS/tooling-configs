import type { Rule } from "@oxlint/plugins";

/** The page that documents `rule`, as a path from the root of a repository that installs this package. */
export function ruleDocPath(rule: string): string {
  return `node_modules/@antelopejs/tooling-configs/docs/rules/${rule}.md`;
}

/** The text every message of `rule` ends with. */
export function docsPointer(rule: string): string {
  return ` Docs: ${ruleDocPath(rule)}`;
}

/** `rules` with every message ending in {@link docsPointer} of its rule. */
export function withRuleDocs(
  rules: Record<string, Rule>,
): Record<string, Rule> {
  return Object.fromEntries(
    Object.entries(rules).map(([name, rule]) => {
      const messages = Object.entries(rule.meta?.messages ?? {}).map(
        ([id, text]) => [id, `${text}${docsPointer(name)}`],
      );
      return [
        name,
        {
          ...rule,
          meta: { ...rule.meta, messages: Object.fromEntries(messages) },
        },
      ];
    }),
  );
}
