import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { TECHNICAL_WRITING_SKILL } from "../docs/technical-writing-skill.ts";
import { UNSLOP_SKILL } from "../docs/unslop-skill.ts";
import { linkPointsAt } from "./links.ts";

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

/** One change to the synced writing skills. */
export type DocsSkillAction =
  | { kind: "write"; path: string; content: string }
  | { kind: "link"; path: string; target: string };

/** What sync changes for the writing skills, and the paths it refuses to overwrite. */
interface DocsSkillsPlan {
  actions: DocsSkillAction[];
  errors: string[];
}

/** The changes that bring the vendored writing skills and their Claude links in line with this pack. */
export function planDocsSkills(root: string): DocsSkillsPlan {
  const actions: DocsSkillAction[] = [];
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
    else if (!linkPointsAt(root, link, target))
      actions.push({ kind: "link", path: link, target });
  }
  return { actions, errors };
}

/** Applies planned changes; a replaced symlink is unlinked first so a write never goes through it. */
export function applyDocsSkillActions(
  root: string,
  actions: readonly DocsSkillAction[],
): void {
  for (const action of actions) {
    const path = join(root, action.path);
    mkdirSync(dirname(path), { recursive: true });
    if (lstatSync(path, { throwIfNoEntry: false }) !== undefined)
      unlinkSync(path);
    if (action.kind === "write") writeFileSync(path, action.content);
    else symlinkSync(action.target, path);
  }
}
