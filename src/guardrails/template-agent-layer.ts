import type { AgentsBlockContext } from "./agents-block.ts";
import { planDocsSkills } from "./docs-skills.ts";
import type { planVerify } from "./verify-skill.ts";

/** The folders a project scaffolded from a template does not get, as `ajs project init` excludes them. */
const SCAFFOLD_EXCLUDED_PATHS = [".agents/", ".claude/skills/"];

/** Whether a scaffold lacks `path`, so a template's AGENTS.md, which every scaffold keeps, must not link it. */
export function inScaffoldExcludedPath(path: string | undefined): boolean {
  return (
    path !== undefined &&
    SCAFFOLD_EXCLUDED_PATHS.some((folder) => path.startsWith(folder))
  );
}

/** The writing skills belong to the agent layer, which the template profile syncs only in the template source. */
export function planWritingSkills(
  root: string,
  profile: AgentsBlockContext["profile"],
  kind: ReturnType<typeof planVerify>["kind"],
): ReturnType<typeof planDocsSkills> {
  if (profile === "template" && kind !== "template")
    return { actions: [], errors: [] };
  return planDocsSkills(root);
}
