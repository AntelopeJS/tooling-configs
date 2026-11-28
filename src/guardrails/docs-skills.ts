import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { TECHNICAL_WRITING_SKILL } from "../docs/technical-writing-skill.ts";
import { UNSLOP_SKILL } from "../docs/unslop-skill.ts";
import type { AgentsBlockContext } from "./agents-block.ts";
import { linkPointsAt } from "./links.ts";
import { VERIFY_CHANGES_SKILL } from "./verify-changes-skill.ts";

/** A skill `antelopejs-sync` installs, by folder name. */
interface SyncedSkill {
  name: string;
  text: string;
}

/** The writing skills `antelopejs-sync` installs in every managed repository. */
const DOCS_SKILLS: readonly SyncedSkill[] = [
  { name: "technical-writing", text: TECHNICAL_WRITING_SKILL },
  { name: "unslop", text: UNSLOP_SKILL },
];

/** The verification skill `antelopejs-sync` installs in a full-profile repository with no `verify-*` skill of its own. */
const VERIFY_SKILL: SyncedSkill = {
  name: "verify-changes",
  text: VERIFY_CHANGES_SKILL,
};

/** The folders that hold a repository's agent skills, `.agents/skills` first. */
const SKILL_DIRECTORIES = [".agents/skills", ".claude/skills"] as const;

/**
 * The folder of each `verify-*` skill the repository wrote itself, relative to the repository root, sorted by name:
 * the synced `verify-changes` excluded, and a skill in both skill folders named once from `.agents/skills`.
 */
function ownVerifySkills(root: string): string[] {
  const folders = new Map<string, string>();
  for (const directory of SKILL_DIRECTORIES) {
    const names = existsSync(join(root, directory))
      ? readdirSync(join(root, directory))
      : [];
    for (const name of names.filter((entry) => entry.startsWith("verify-")))
      if (name !== VERIFY_SKILL.name && !folders.has(name))
        folders.set(name, `${directory}/${name}`);
  }
  return [...folders]
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([, folder]) => folder);
}

/** The folder of each verification skill the AGENTS.md block points to: the repository's own, else the synced one. */
export function verifySkillFolders(root: string): string[] {
  const own = ownVerifySkills(root);
  return own.length ? own : [docsSkillFolder(VERIFY_SKILL.name)];
}

/** The folder of a writing skill, relative to the repository root. */
function docsSkillFolder(name: string): string {
  return `.agents/skills/${name}`;
}

/** The folder of each writing skill, relative to the repository root. */
export function docsSkillFolders(): string[] {
  return DOCS_SKILLS.map(({ name }) => docsSkillFolder(name));
}

/** The file of a writing skill, relative to the repository root. */
function docsSkillPath(name: string): string {
  return `${docsSkillFolder(name)}/SKILL.md`;
}

/** The `.claude/skills` link that exposes a writing skill to Claude Code. */
function docsSkillLink(name: string): string {
  return `.claude/skills/${name}`;
}

/** Every path under the agent directories that `antelopejs-sync` writes for the skills it syncs. */
export function docsSkillPaths(): string[] {
  return [...DOCS_SKILLS, VERIFY_SKILL].flatMap(({ name }) => [
    docsSkillPath(name),
    docsSkillLink(name),
  ]);
}

/** One change to the synced skills. */
export type DocsSkillAction =
  | { kind: "write"; path: string; content: string }
  | { kind: "link"; path: string; target: string }
  | { kind: "remove"; path: string };

/** What sync changes for the synced skills, and the paths it refuses to overwrite. */
interface DocsSkillsPlan {
  actions: DocsSkillAction[];
  errors: string[];
}

/** The synced `verify-changes` files to remove once the repository has a `verify-*` skill of its own. */
function retiredVerifySkill(root: string): DocsSkillAction[] {
  const file = docsSkillPath(VERIFY_SKILL.name);
  const link = docsSkillLink(VERIFY_SKILL.name);
  const stat = (path: string) =>
    lstatSync(join(root, path), { throwIfNoEntry: false });
  return [
    ...(stat(file)?.isFile() ? [file] : []),
    ...(stat(link)?.isSymbolicLink() ? [link] : []),
  ].map((path) => ({ kind: "remove", path }));
}

/**
 * The changes that bring the vendored skills and their Claude links in line with this pack. The full profile also gets
 * `verify-changes`, unless the repository has a `verify-*` skill of its own, which retires a synced `verify-changes`.
 */
export function planDocsSkills(
  root: string,
  profile: AgentsBlockContext["profile"] = "full",
): DocsSkillsPlan {
  const actions: DocsSkillAction[] = [];
  const errors: string[] = [];
  const skills = [...DOCS_SKILLS];
  if (profile === "full") {
    if (ownVerifySkills(root).length) actions.push(...retiredVerifySkill(root));
    else skills.push(VERIFY_SKILL);
  }
  for (const { name, text } of skills) {
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

/** Applies planned changes; a replaced symlink is unlinked first so a write never goes through it, and a removal that empties its folder removes the folder. */
export function applyDocsSkillActions(
  root: string,
  actions: readonly DocsSkillAction[],
): void {
  for (const action of actions) {
    const path = join(root, action.path);
    if (action.kind === "remove") {
      unlinkSync(path);
      if (!readdirSync(dirname(path)).length) rmdirSync(dirname(path));
      continue;
    }
    mkdirSync(dirname(path), { recursive: true });
    if (lstatSync(path, { throwIfNoEntry: false }) !== undefined)
      unlinkSync(path);
    if (action.kind === "write") writeFileSync(path, action.content);
    else symlinkSync(action.target, path);
  }
}
