import { lstatSync } from "node:fs";
import { join } from "node:path";

import type { AgentsBlockContext } from "./agents-block.ts";
import { planDocsSkills } from "./docs-skills.ts";

/**
 * Whether the repository is the template source: a template-profile repository with an `.agents/` folder at its root,
 * which `ajs project init` excludes from a scaffold, so a scaffold is never taken for the source.
 */
export function isTemplateSource(
  root: string,
  profile: AgentsBlockContext["profile"],
): boolean {
  return (
    profile === "template" &&
    lstatSync(join(root, ".agents"), {
      throwIfNoEntry: false,
    })?.isDirectory() === true
  );
}

/** The writing skills belong to the agent layer, which the template profile syncs only in the template source. */
export function planWritingSkills(
  root: string,
  profile: AgentsBlockContext["profile"],
): ReturnType<typeof planDocsSkills> {
  if (profile === "template" && !isTemplateSource(root, profile))
    return { actions: [], errors: [] };
  return planDocsSkills(root);
}
