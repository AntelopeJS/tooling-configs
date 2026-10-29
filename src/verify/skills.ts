import type { VerifyKind } from "./kinds.ts";

/** The synced SKILL.md of a kind, the part of the skill `antelopejs-sync` owns. */
export function skillText(kind: VerifyKind): string {
  return `---\nname: verify-${kind}\ndescription: "Placeholder until the skill text lands."\n---\n\n# Verify ${kind}\n`;
}
