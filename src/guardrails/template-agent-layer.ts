import { existsSync } from "node:fs";
import { join } from "node:path";

import type { AgentsBlockContext } from "./agents-block.ts";
import { docsSkillFolders, planDocsSkills } from "./docs-skills.ts";

/**
 * Whether the repository is the template source: a template-profile repository that holds the folder of a writing skill
 * this pack syncs. `ajs project init` excludes `.agents/` from a scaffold, and no other tool names a skill folder like these,
 * so a scaffold whose `.agents/skills/` gains other skills is never taken for the source.
 */
export function isTemplateSource(
  root: string,
  profile: AgentsBlockContext["profile"],
): boolean {
  return (
    profile === "template" &&
    docsSkillFolders().some((folder) => existsSync(join(root, folder)))
  );
}

/** The synced skills belong to the agent layer, which the template profile syncs only in the template source. */
export function planWritingSkills(
  root: string,
  profile: AgentsBlockContext["profile"],
): ReturnType<typeof planDocsSkills> {
  if (profile === "template" && !isTemplateSource(root, profile))
    return { actions: [], errors: [] };
  return planDocsSkills(root, profile);
}
