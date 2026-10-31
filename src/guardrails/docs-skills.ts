import { existsSync, lstatSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";

import { TECHNICAL_WRITING_SKILL } from "../docs/technical-writing-skill.ts";
import { UNSLOP_SKILL } from "../docs/unslop-skill.ts";
import type { VerifyAction } from "./verify-skill.ts";

/** The writing skills `antelopejs-sync` installs in every managed repository, by folder name. */
const DOCS_SKILLS = [
  { name: "technical-writing", text: TECHNICAL_WRITING_SKILL },
  { name: "unslop", text: UNSLOP_SKILL },
] as const;

/** The file of a writing skill, relative to the repository root. */
function docsSkillPath(name: string): string {
  return `.agents/skills/${name}/SKILL.md`;
}

/** The `.claude/skills` link that exposes a writing skill to Claude Code. */
function docsSkillLink(name: string): string {
  return `.claude/skills/${name}`;
}

/** Every path under the agent directories that `antelopejs-sync` writes for the writing skills. */
export function docsSkillPaths(): string[] {
  return DOCS_SKILLS.flatMap(({ name }) => [
    docsSkillPath(name),
    docsSkillLink(name),
  ]);
}

/** What sync changes for the writing skills, and the paths it refuses to overwrite. */
interface DocsSkillsPlan {
  actions: VerifyAction[];
  errors: string[];
}

/** The changes that bring the vendored writing skills and their Claude links in line with this pack. */
export function planDocsSkills(root: string): DocsSkillsPlan {
  const actions: VerifyAction[] = [];
  const errors: string[] = [];
  for (const { name, text } of DOCS_SKILLS) {
    const path = docsSkillPath(name);
    const file = join(root, path);
    if (lstatSync(file, { throwIfNoEntry: false })?.isDirectory())
      errors.push(
        `${path} is a folder. Move it away, then rerun antelopejs-sync.`,
      );
    else if (!existsSync(file) || readFileSync(file, "utf8") !== text)
      actions.push({ kind: "write", path, content: text });
    const link = docsSkillLink(name);
    const target = `../../.agents/skills/${name}`;
    const stat = lstatSync(join(root, link), { throwIfNoEntry: false });
    if (stat === undefined) actions.push({ kind: "link", path: link, target });
    else if (!stat.isSymbolicLink())
      errors.push(
        `${link} is not a symlink. Move it away, then rerun antelopejs-sync.`,
      );
    else if (readlinkSync(join(root, link)) !== target)
      actions.push({ kind: "link", path: link, target });
  }
  return { actions, errors };
}
