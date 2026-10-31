import {
  HOUSE_CHECKS,
  UNSLOP_GROUPS,
  UNSLOP_RULES,
  type UnslopCheck,
  type UnslopRule,
} from "./unslop-rules.ts";

/** The Vale style name; its rules live in `styles/AntelopeJS/`. */
const VALE_STYLE = "AntelopeJS";

/** The Vale configuration the docs action runs with: every rule of the style, warnings and above. */
const VALE_INI = `StylesPath = styles
MinAlertLevel = warning

[*.md]
BasedOnStyles = ${VALE_STYLE}
`;

/** The unslop skill's rule section, from its heading to the end of the file. */
export function renderRuleSection(rules: readonly UnslopRule[]): string {
  const sections = UNSLOP_GROUPS.map((group) => {
    const lines = rules
      .filter((rule) => rule.group === group)
      .map((rule) => `${rule.id}. ${rule.text}`);
    return `### ${group}\n\n${lines.join("\n")}\n`;
  });
  return `## Patterns to detect and fix\n\nRule numbers are stable ids that other skills cite. A removed rule leaves a gap.\n\n${sections.join("\n")}`;
}

function list(items: readonly string[]): string {
  return items.map((item) => `  - ${JSON.stringify(item)}`).join("\n");
}

function renderCheck(check: UnslopCheck): string {
  const head = `extends: ${check.kind}\nmessage: ${JSON.stringify(check.message)}\nlevel: warning\n`;
  if (check.kind === "existence")
    return `${head}${check.ignorecase ? "ignorecase: true\n" : ""}${check.nonword ? "nonword: true\n" : ""}tokens:\n${list(check.tokens)}\n`;
  if (check.kind === "substitution")
    return `${head}${check.ignorecase ? "ignorecase: true\n" : ""}swap:\n${Object.entries(
      check.swap,
    )
      .map(([from, to]) => `  ${JSON.stringify(from)}: ${JSON.stringify(to)}`)
      .join("\n")}\n`;
  return `${head}scope: heading\nmatch: $sentence\nexceptions:\n${list(check.exceptions)}\n`;
}

/** Every generated file of the Vale configuration, by path relative to the `vale` folder. */
export function valeFiles(
  rules: readonly UnslopRule[] = UNSLOP_RULES,
): Map<string, string> {
  const files = new Map<string, string>([["vale.ini", VALE_INI]]);
  for (const rule of rules) {
    if (rule.check)
      files.set(
        `styles/${VALE_STYLE}/Unslop${String(rule.id).padStart(2, "0")}.yml`,
        renderCheck(rule.check),
      );
  }
  for (const { name, check } of HOUSE_CHECKS)
    files.set(`styles/${VALE_STYLE}/${name}.yml`, renderCheck(check));
  return files;
}
