import { renderRuleSection } from "./vale-style.ts";
import { UNSLOP_RULES } from "./unslop-rules.ts";

const HEAD: string =
  [
    "---",
    "name: unslop",
    "description: Cut AI tells from any writing.",
    "disable-model-invocation: true",
    "---",
    "",
    "# Unslop",
    "",
    "Edit text to remove AI patterns. Scan for the patterns below, then rewrite. Preserve meaning and match the intended tone.",
  ].join("\n") + "\n\n";

/** The unslop skill, vendored from Upd4ting/agent-config `claude/skills/unslop/SKILL.md` at 4e0a848. The rule section is rendered from the rules table; a test pins the whole text to the upstream copy. */
export const UNSLOP_SKILL: string = HEAD + renderRuleSection(UNSLOP_RULES);
