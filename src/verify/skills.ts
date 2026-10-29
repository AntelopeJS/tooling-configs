import { skillFolder, type VerifyKind } from "./kinds.ts";

/** The synced SKILL.md of a kind, the part of the skill `antelopejs-sync` owns. */
export function skillText(kind: VerifyKind): string {
  return `---\nname: verify-${kind}\ndescription: "Placeholder until the skill text lands."\n---\n\n# Verify ${kind}\n`;
}

/** The skill folder's package.json: it makes verify.config.ts an ES module and keeps the folder out of published packages. */
const SKILL_PACKAGE = `${JSON.stringify({ private: true, type: "module" }, null, 2)}\n`;

/** Every file of a kind's synced layer, by path relative to the repository root. */
export function syncedFiles(
  kind: VerifyKind,
): { path: string; content: string }[] {
  return [
    { path: `${skillFolder(kind)}/SKILL.md`, content: skillText(kind) },
    { path: `${skillFolder(kind)}/package.json`, content: SKILL_PACKAGE },
  ];
}
